#!/usr/bin/env node
// Regenerates src/lib/database.types.ts from the live schema without ever
// leaving a broken or empty file in place: the CLI's output is captured to a
// temp file, validated, then atomically renamed over the target. A failed or
// malformed generation exits non-zero and leaves the existing file untouched.
import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(REPO, 'src/lib/database.types.ts')

// Local mode (Reqon redesign Phase 1 prerequisite, docs/redesign/phases/00.md):
// generate from a migrated disposable/local Postgres instead of the hosted
// project, via the CLI's own --db-url flag. Never falls back to the hosted
// path silently — either LOCAL_DB_URL is set and this uses it, or it is
// unset and behavior is exactly as before (SUPABASE_PROJECT_ID required).
// scripts/gen-types-local.sh drives the disposable container and sets this.
const localDbUrl = process.env.LOCAL_DB_URL
const projectId = process.env.SUPABASE_PROJECT_ID
if (!localDbUrl && !projectId) {
  console.error(
    'Neither LOCAL_DB_URL nor SUPABASE_PROJECT_ID is set. Refusing to run — the previous types file is untouched.\n' +
      'For local generation from a migrated disposable database, run: npm run types:gen:local',
  )
  process.exit(1)
}

// Staged NEXT TO the target, not in os.tmpdir(): /tmp is often a separate
// filesystem (tmpfs), where rename() fails with EXDEV and the only fallback is
// writing straight into the target — which an interrupted write can truncate.
// Same directory means the final rename is always same-filesystem and atomic.
const tmpFile = join(dirname(TARGET), `.database.types.${process.pid}.tmp`)

try {
  // supabase is a pinned devDependency (see package.json); npx resolves it
  // from node_modules/.bin rather than requiring a global install.
  const sourceArgs = localDbUrl ? ['--db-url', localDbUrl] : ['--project-id', projectId]
  const output = execFileSync(
    'npx',
    ['--no-install', 'supabase', 'gen', 'types', 'typescript', ...sourceArgs, '--schema', 'public'],
    { encoding: 'utf8', cwd: REPO },
  )

  // Thrown, not process.exit(): exit() would skip the `finally` below and
  // leave the staged temp file behind in src/lib.
  if (output.trim().length === 0) throw new Error('generator produced empty output')
  if (!output.includes('export type Database')) {
    throw new Error('generator output does not contain "export type Database"')
  }

  writeFileSync(tmpFile, output)
  // Re-read what was written and re-check, in case of a partial/encoding-mangled write.
  const written = readFileSync(tmpFile, 'utf8')
  if (written.trim().length === 0 || !written.includes('export type Database')) {
    throw new Error('the staged file failed validation after writing')
  }

  renameSync(tmpFile, TARGET) // atomic: same directory, same filesystem
  console.log(`wrote ${TARGET}`)
} catch (err) {
  console.error(`types:gen failed: ${err.message ?? err}. The previous types file is untouched.`)
  process.exitCode = 1
} finally {
  rmSync(tmpFile, { force: true })
}
