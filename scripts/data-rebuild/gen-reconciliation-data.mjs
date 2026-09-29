// Writes the per-clause data blocks of the 2026-09-29 reconciliation
// migrations from the SMC Data Rebuild Pack, after proving the inputs are the
// reviewed ones.
//
//   node scripts/data-rebuild/gen-reconciliation-data.mjs          rewrite the blocks
//   node scripts/data-rebuild/gen-reconciliation-data.mjs --check  fail if they differ
//
// Inputs are pinned by sha256 twice: here, and in the pack's own
// PACK_MANIFEST.json. The page map must also agree, clause for clause, with
// the repository's independent extraction (supabase/book/ms2627-rev-01.pages.json)
// and carry the verified book's hash and edition on every row. Nothing here
// touches a database.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pack = join(root, 'supabase/changes/SMC_Data_Rebuild_Pack')

const REGS_REF = 'MS2627 Rev.01'
const BOOK_SHA256 = '53013ec6dd272c81379dd5f709f8a76f84c5b453b265ee8f7661ecc6d8bf7669'
const PAGE_COUNT = 234
const TARGETS = new Set(['SWDATA', 'MECH', 'ELEC', 'BUILD', 'OPS'])
const INPUTS = {
  'data/requirement_department_suggestions.json': '7983335c1c1b8aabd3110851f52421525e7a363027312ea59bb48fa9d68e8f71',
  'data/requirement_page_map.json': '319a8d4c4fe6e28b457fd4cff74f2e10b895a3a6cbdd2db633168d05bb217369',
  'data/requirements_reference.json': null, // pinned by the manifest only
}
const EXPECTED = { clauses: 1146, assigned: 757, unassigned: 389 }

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const fail = (msg) => {
  console.error(`gen-reconciliation-data: ${msg}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(pack, 'PACK_MANIFEST.json'), 'utf8'))
const load = (rel) => {
  const buf = readFileSync(join(pack, rel))
  const actual = sha256(buf)
  const listed = manifest.find((e) => e.path === rel)?.sha256
  if (!listed) fail(`${rel} is not in PACK_MANIFEST.json`)
  if (actual !== listed) fail(`${rel} sha256 ${actual} does not match the pack manifest (${listed})`)
  if (INPUTS[rel] && actual !== INPUTS[rel]) fail(`${rel} sha256 ${actual} is not the reviewed version ${INPUTS[rel]}`)
  return JSON.parse(buf.toString('utf8'))
}

const bookSha = sha256(readFileSync(join(root, 'static/book/MS2627_MotoStudent.pdf')))
if (bookSha !== BOOK_SHA256) fail(`static/book/MS2627_MotoStudent.pdf sha256 ${bookSha} is not the verified edition`)

const reference = load('data/requirements_reference.json')
const suggestions = load('data/requirement_department_suggestions.json')
const pageMap = load('data/requirement_page_map.json')
const repoMap = JSON.parse(readFileSync(join(root, 'supabase/book/ms2627-rev-01.pages.json'), 'utf8'))

const subjectOf = new Map(reference.map((c) => [c.clause_key, c.source_taxonomy_key]))
if (subjectOf.size !== EXPECTED.clauses) fail(`reference has ${subjectOf.size} clauses, expected ${EXPECTED.clauses}`)

// ------------------------------------------------------------- clause owners
const owners = []
const seen = new Set()
for (const s of suggestions) {
  if (seen.has(s.clause_key)) fail(`duplicate suggestion for ${s.clause_key}`)
  seen.add(s.clause_key)
  if (s.season_key !== '2026/27') fail(`${s.clause_key}: unexpected season ${s.season_key}`)
  if (s.changes_compliance_status !== false) fail(`${s.clause_key}: a suggestion may never change compliance status`)
  const subject = subjectOf.get(s.clause_key)
  if (!subject) fail(`${s.clause_key}: not in the reference clause list`)
  const owner = s.assignment_state === 'suggested' ? s.department_key : null
  if (s.assignment_state === 'suggested' && !TARGETS.has(owner)) fail(`${s.clause_key}: unknown department ${owner}`)
  if (s.assignment_state !== 'suggested' && s.department_key !== null) fail(`${s.clause_key}: unassigned row names a department`)
  owners.push([s.clause_key, subject, owner])
}
const assigned = owners.filter((o) => o[2] !== null).length
if (owners.length !== EXPECTED.clauses || assigned !== EXPECTED.assigned || owners.length - assigned !== EXPECTED.unassigned) {
  fail(`owner counts ${owners.length}/${assigned}/${owners.length - assigned} differ from ${JSON.stringify(EXPECTED)}`)
}

// -------------------------------------------------------------- clause pages
const repoPage = new Map(repoMap.entries.map((e) => [e.clause_key, e.printed_page]))
if (repoMap.sha256 !== BOOK_SHA256 || repoMap.edition !== REGS_REF) fail('repository page map is for another book')
const pages = []
for (const p of pageMap) {
  if (p.regs_ref !== REGS_REF || p.book_sha256 !== BOOK_SHA256) fail(`${p.clause_key}: page from another edition/file`)
  if (!Number.isInteger(p.source_page) || p.source_page < 1 || p.source_page > PAGE_COUNT) fail(`${p.clause_key}: page ${p.source_page} out of range`)
  if (p.source_page !== p.pdf_page_1_based) fail(`${p.clause_key}: printed and PDF page differ; page_offset 0 would be wrong`)
  if (!subjectOf.has(p.clause_key)) fail(`${p.clause_key}: not in the reference clause list`)
  if (repoPage.get(p.clause_key) !== p.source_page) {
    fail(`${p.clause_key}: pack page ${p.source_page} disagrees with the repository extraction (${repoPage.get(p.clause_key)})`)
  }
  pages.push([p.clause_key, p.source_page])
}
if (pages.length !== EXPECTED.clauses || new Set(pages.map((p) => p[0])).size !== EXPECTED.clauses) fail('page map does not cover every clause exactly once')

const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
owners.sort(byKey)
pages.sort(byKey)

// ---------------------------------------------------------------- write/check
// The block carries the md5 of its own text: maintenance.checked_json()
// refuses to run on anything that was altered in transit (a copy made by
// hand, a truncated paste), which a range check alone would not notice.
const block = (rows) => {
  const text = `[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]`
  const md5 = createHash('md5').update(text, 'utf8').digest('hex')
  return `maintenance.checked_json($json$${text}$json$, '${md5}')`
}

const targets = [
  ['supabase/migrations/20260125000100_five_department_structure.sql', 'clause-owners', block(owners)],
  ['supabase/migrations/20260125000200_requirements_book_page_map.sql', 'clause-pages', block(pages)],
]

const check = process.argv.includes('--check')
let stale = 0
for (const [rel, name, body] of targets) {
  const file = join(root, rel)
  const text = readFileSync(file, 'utf8')
  const open = `-- <generated:${name}>\n`
  const close = `-- </generated:${name}>`
  const start = text.indexOf(open)
  const end = text.indexOf(close)
  if (start < 0 || end < start) fail(`${rel}: markers for ${name} not found`)
  const next = text.slice(0, start + open.length) + body + '\n' + text.slice(end)
  if (next === text) {
    console.log(`ok     ${rel} (${name})`)
  } else if (check) {
    console.log(`STALE  ${rel} (${name})`)
    stale++
  } else {
    writeFileSync(file, next)
    console.log(`wrote  ${rel} (${name})`)
  }
}
console.log(`clauses ${owners.length}: ${assigned} assigned, ${owners.length - assigned} unassigned; pages ${pages.length} within 1..${PAGE_COUNT}; book ${BOOK_SHA256.slice(0, 12)}…`)
if (stale) process.exit(1)
