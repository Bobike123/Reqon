#!/usr/bin/env node
// Upload the verified Requirements Book PDF to a HOSTED Supabase project's
// private `regulations` bucket and point the edition's regulation_documents
// row at it. The hosted counterpart of `npm run book:sync:local` (which never
// leaves this machine); page numbers are NOT touched here — migration
// 20260125000200 records them.
//
//   SUPABASE_SERVICE_ROLE_KEY=… node scripts/book/upload-hosted.mjs --project-ref <ref> [--dry-run]
//
// The key is read from the environment of this one process: never printed,
// never written, never a VITE_ variable. The project URL comes from
// .env.local (VITE_SUPABASE_URL) and must match --project-ref exactly, so a
// key for one project can never be used against another by accident.
//
// What it may change, and nothing else:
//   * Storage: adds ONE object, editions/<edition>/<sha256 prefix>.pdf (the
//     same key the local sync uses). Never overwrites or deletes one; an
//     existing object at that key is accepted only if its bytes hash to the
//     verified book.
//   * regulation_documents (the edition's existing row, never a new one):
//     storage_path — only when the row has no source yet or already names this
//     object. url stays NULL; no signed URL is ever stored.
// The upload is read back and hashed before the row is written, so an
// interrupted run leaves the previous state usable and simply runs again.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const die = (msg) => {
  console.error(`upload-hosted: ${msg}`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const refAt = argv.indexOf('--project-ref')
const projectRef = refAt >= 0 ? argv[refAt + 1] : null
if (!projectRef || !/^[a-z0-9]{20}$/.test(projectRef)) die('pass --project-ref <20-character project ref>')

const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!key) die('SUPABASE_SERVICE_ROLE_KEY is not set in this process environment')

const envLocal = readFileSync(path.join(REPO, '.env.local'), 'utf8')
const apiUrl = /^VITE_SUPABASE_URL=(.+)$/m.exec(envLocal)?.[1]?.trim()
if (!apiUrl) die('.env.local has no VITE_SUPABASE_URL')
if (new URL(apiUrl).hostname !== `${projectRef}.supabase.co`) die(`.env.local points at ${new URL(apiUrl).hostname}, not ${projectRef}`)

const config = JSON.parse(readFileSync(path.join(REPO, 'supabase/book/editions.json'), 'utf8'))
const edition = config.editions.find((e) => e.regs_ref === 'MS2627 Rev.01') ?? die('no MS2627 Rev.01 in supabase/book/editions.json')
const bytes = readFileSync(path.join(REPO, edition.source))
const fingerprint = sha256(bytes)
if (fingerprint !== edition.sha256) die(`${edition.source} is not the pinned file (sha256 ${fingerprint})`)
if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) die(`${edition.source} is not a PDF`)
const objectKey = `editions/${slug(edition.regs_ref)}/${fingerprint.slice(0, 16)}.pdf`
const bucket = config.bucket

const headers = { apikey: key, Authorization: `Bearer ${key}` }
const objectUrl = `${apiUrl}/storage/v1/object/${bucket}/${objectKey.split('/').map(encodeURIComponent).join('/')}`
const rowUrl = `${apiUrl}/rest/v1/regulation_documents?regs_ref=eq.${encodeURIComponent(edition.regs_ref)}`

async function download() {
  const res = await fetch(objectUrl, { headers })
  if (res.ok) return Buffer.from(await res.arrayBuffer())
  if (res.status === 404 || res.status === 400) return null
  die(`reading ${bucket}/${objectKey} failed (HTTP ${res.status})`)
}

const b = await fetch(`${apiUrl}/storage/v1/bucket/${bucket}`, { headers })
if (!b.ok) die(`the hosted project has no "${bucket}" bucket (HTTP ${b.status}); apply migration 20260120000000 first`)
if ((await b.json()).public !== false) die(`the "${bucket}" bucket is not private; refusing to upload`)

const rowRes = await fetch(rowUrl, { headers })
if (!rowRes.ok) die(`reading regulation_documents failed (HTTP ${rowRes.status})`)
const [row] = await rowRes.json()
if (!row) die(`no regulation_documents row for ${edition.regs_ref}; the migrations create it`)
if (row.url || (row.storage_path && row.storage_path !== objectKey)) {
  die(`the row already names another source (${row.url ? 'a URL' : row.storage_path}); change it deliberately in Settings, not here`)
}

console.log(`project   ${projectRef}`)
console.log(`file      ${edition.source} (${bytes.length} bytes, sha256 ${fingerprint.slice(0, 16)}…)`)
console.log(`object    ${bucket}/${objectKey}`)
console.log(`row now   storage_path=${row.storage_path ?? 'null'} page_count=${row.page_count ?? 'null'} page_offset=${row.page_offset}`)

let existing = await download()
if (existing && sha256(existing) !== fingerprint) die(`an object already exists at ${objectKey} with DIFFERENT bytes; not touching it`)
if (dryRun) {
  console.log(`dry run   would ${existing ? 'reuse the verified existing object' : 'upload'}${row.storage_path === objectKey ? '' : ' and set storage_path'}; nothing written`)
  process.exit(0)
}

if (!existing) {
  const up = await fetch(objectUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/pdf', 'x-upsert': 'false', 'Cache-Control': 'max-age=3600' },
    body: bytes,
  })
  if (!up.ok && up.status !== 409) die(`upload refused (HTTP ${up.status})`)
  existing = await download()
  if (!existing || sha256(existing) !== fingerprint) die('the uploaded object does not read back as the verified file; the row was NOT changed')
  console.log('uploaded  and read back: sha256 matches')
} else {
  console.log('object    already present and verified: sha256 matches')
}

if (row.storage_path !== objectKey) {
  const patch = await fetch(`${rowUrl}&url=is.null`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ storage_path: objectKey }),
  })
  if (!patch.ok) die(`updating regulation_documents failed (HTTP ${patch.status}); the object is uploaded, run again`)
  const [after] = await patch.json()
  if (after?.storage_path !== objectKey) die('the row does not name the uploaded object after the write')
}
console.log(`done      ${edition.regs_ref} -> ${bucket}/${objectKey}`)
