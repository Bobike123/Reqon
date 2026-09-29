#!/usr/bin/env node
// ADR-0011: a deterministic, dependency-free guard for the module boundaries
// docs/ARCHITECTURE.md §1 documents (pages -> ui/data/domain/season/auth;
// data -> season/domain/infra; domain -> infra for types only). No import
// resolver, no AST parser — a regex over import specifiers is enough to
// catch the mistakes that matter: a page reaching around its data hook
// straight into Supabase, a pure model quietly growing a network dependency,
// or two files importing each other in a cycle nobody noticed forming.
//
// Runs as part of `npm run lint`. Exits 1 and prints every violation found
// (not just the first) so a single run tells you everything to fix.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src')

// -------------------------------------------------------------- file walk
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const files = walk(SRC)
const rel = (abs) => path.relative(SRC, abs).split(path.sep).join('/')

// -------------------------------------------------------- import specifiers
// Matches `import ... from '...'`, `import '...'`, and `export ... from '...'`.
// Deliberately simple: this project has no dynamic `import()` of another
// source module worth tracking here (route-level lazy() targets are still
// plain relative specifiers to the same files this walk already sees).
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?\bfrom\s+['"]([^'"]+)['"]/g

function importsOf(absPath) {
  const text = readFileSync(absPath, 'utf8')
  const specifiers = []
  for (const m of text.matchAll(IMPORT_RE)) specifiers.push(m[1])
  return specifiers
}

// Resolve a relative specifier to a project-relative path (best effort — this
// only needs to be right for files that exist under src/, which every
// relative import in this codebase resolves to).
function resolveRelative(fromAbs, specifier) {
  if (!specifier.startsWith('.')) return null
  const resolved = path.normalize(path.join(path.dirname(fromAbs), specifier))
  for (const candidate of [resolved, `${resolved}.ts`, `${resolved}.tsx`]) {
    if (files.includes(candidate)) return candidate
  }
  return null
}

const violations = []

// ------------------------------------------------- rule 1: lib/supabase
// Only data/, auth/, roles/useMemberRoles.ts and main.tsx may import the
// Supabase client directly — every other consumer goes through a data hook.
const SUPABASE_ALLOWED = (relPath) =>
  relPath.startsWith('data/') ||
  relPath.startsWith('auth/') ||
  relPath === 'roles/useMemberRoles.ts' ||
  relPath === 'main.tsx'

for (const file of files) {
  const relPath = rel(file)
  if (relPath.endsWith('.test.ts') || relPath.endsWith('.test.tsx')) continue
  if (SUPABASE_ALLOWED(relPath)) continue
  for (const specifier of importsOf(file)) {
    if (specifier.includes('lib/supabase')) {
      violations.push(`${relPath}: imports lib/supabase directly (only data/, auth/, roles/useMemberRoles.ts and main.tsx may)`)
    }
  }
}

// --------------------------------- rule 2: pure models/domain modules stay pure
// A `*Model.ts` file, or a plain `.ts` file inside one of the small domain
// module folders (departments/, tasks/, proposals/, specs/, book/ —
// ADR-0011's table), must not import from data/ or import a use*() hook from
// anywhere. Scoped to `.ts`, not `.tsx`: those folders also hold ordinary UI
// components (e.g. proposals/PromoteDialog.tsx), which — like anything under
// ui/ or pages/ — legitimately call data hooks; ADR-0011's own module list
// (priority.ts, lifecycle.ts, progress.ts, scope.ts, taskState.ts, types.ts)
// is entirely `.ts` for exactly this reason.
const DOMAIN_DIRS = ['departments/', 'tasks/', 'proposals/', 'specs/', 'book/', 'activity/']
const isModelFile = (relPath) => /Model\.ts$/.test(relPath)
const isDomainModule = (relPath) => relPath.endsWith('.ts') && DOMAIN_DIRS.some((d) => relPath.startsWith(d))
const HOOK_IMPORT_RE = /(?:^|\/)use[A-Z]\w*(\.tsx?)?$/

for (const file of files) {
  const relPath = rel(file)
  if (relPath.endsWith('.test.ts') || relPath.endsWith('.test.tsx')) continue
  if (!isModelFile(relPath) && !isDomainModule(relPath)) continue
  for (const specifier of importsOf(file)) {
    if (specifier.includes('/data/') || specifier.startsWith('data/') || specifier.includes('../data/')) {
      violations.push(`${relPath}: a pure model/domain module imports from data/ (${specifier})`)
    }
    const base = specifier.split('/').pop() ?? ''
    if (HOOK_IMPORT_RE.test(base) && base !== path.basename(relPath).replace(/\.tsx?$/, '')) {
      violations.push(`${relPath}: a pure model/domain module imports a use*() hook (${specifier})`)
    }
  }
}

// -------------------------------------------------------------- rule 3: cycles
// A directed graph over resolved relative imports; any file reachable from
// itself is a cycle. Reports one representative path per cycle found, not
// every rotation of it.
const graph = new Map()
for (const file of files) {
  const edges = []
  for (const specifier of importsOf(file)) {
    const target = resolveRelative(file, specifier)
    if (target) edges.push(target)
  }
  graph.set(file, edges)
}

const seenCycleStarts = new Set()
function findCycle(start) {
  const onStack = new Set([start])
  const visited = new Set([start])

  function dfs(node, pathSoFar) {
    for (const next of graph.get(node) ?? []) {
      if (onStack.has(next)) {
        return [...pathSoFar, next]
      }
      if (visited.has(next)) continue
      visited.add(next)
      onStack.add(next)
      const found = dfs(next, [...pathSoFar, next])
      onStack.delete(next)
      if (found) return found
    }
    return null
  }

  return dfs(start, [start])
}

for (const file of files) {
  if (seenCycleStarts.has(file)) continue
  const cycle = findCycle(file)
  if (cycle) {
    for (const node of cycle) seenCycleStarts.add(node)
    violations.push(`import cycle: ${cycle.map(rel).join(' -> ')}`)
  }
}

// ------------------------------------------------------------------- report
if (violations.length > 0) {
  console.error(`Module boundary check failed — ${violations.length} violation(s):\n`)
  for (const v of violations) console.error(`  - ${v}`)
  console.error('\nSee docs/redesign/adr/0011-module-boundaries.md for the rules.')
  process.exit(1)
}

console.log(`Module boundary check passed — ${files.length} files, no violations.`)
