// End-to-end check of the attachment Edge Functions against the LOCAL Supabase stack
// (Ultraplan Phase 2). Real users, real HTTP calls to /functions/v1/*, real bytes through the stack's
// S3 endpoint — the same code path that talks to Cloudflare R2 in production.
//
//   npx supabase functions serve --env-file supabase/functions/.env.local   (in another terminal)
//   node scripts/attachments/e2e-local.mjs
//
// Local only, by construction: every target comes from `supabase status` of THIS checkout and the
// script refuses any API URL that is not 127.0.0.1 / localhost. Fixtures are @attach-e2e.test
// identities and one task; they are removed at the end, pass or fail (objects included).
// Exit status 0 = every check passed.

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { signRequest } from '../../supabase/functions/_shared/sigv4.ts'

const ROOT = new URL('../..', import.meta.url).pathname
const status = Object.fromEntries(
  execSync('npx supabase status -o env', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]
    }),
)
const API = status.API_URL
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(API ?? '')) {
  console.error('Refusing: the API URL is not the local stack.')
  process.exit(1)
}
const ANON = status.ANON_KEY
const SERVICE = status.SERVICE_ROLE_KEY
const fnEnv = Object.fromEntries(
  readFileSync(`${ROOT}supabase/functions/.env.local`, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)
const S3 = {
  base: fnEnv.ATTACHMENTS_S3_PUBLIC_ENDPOINT,
  bucket: fnEnv.ATTACHMENTS_S3_BUCKET,
  creds: { accessKeyId: fnEnv.ATTACHMENTS_S3_ACCESS_KEY_ID, secretAccessKey: fnEnv.ATTACHMENTS_S3_SECRET_ACCESS_KEY, region: fnEnv.ATTACHMENTS_S3_REGION },
}

// ------------------------------------------------------------------ helpers
const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok: Boolean(ok), detail })
  console.log(`${ok ? '    ok  ' : '    FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`)
}

async function http(method, path, { token, apikey = ANON, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      apikey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json }
}

const asService = (method, path, body, headers = {}) =>
  http(method, path, { token: SERVICE, apikey: SERVICE, body, headers: { Prefer: 'return=representation', ...headers } })
const fn = (name, token, body, headers) => http('POST', `/functions/v1/${name}`, { token, body, headers })

async function headObject(key) {
  const url = `${S3.base}/${S3.bucket}/${key}`
  const res = await fetch(url, { method: 'HEAD', headers: await signRequest(S3.creds, { method: 'HEAD', url }) })
  return res.status
}

function bytes(n, fill) {
  return new Uint8Array(n).fill(fill)
}

async function put(target, data) {
  const res = await fetch(target.url, { method: 'PUT', headers: target.headers, body: data })
  return res.status
}

// ------------------------------------------------------------------ fixtures
const run = randomUUID().slice(0, 8)
const password = `e2e-${randomUUID()}`
const people = {}
let taskId = null

async function makeUser(tag, member) {
  const email = `${tag}-${run}@attach-e2e.test`
  const created = await http('POST', '/auth/v1/admin/users', {
    token: SERVICE,
    apikey: SERVICE,
    body: { email, password, email_confirm: true },
  })
  if (created.status !== 200) throw new Error(`could not create ${tag}: ${created.status}`)
  const id = created.json.id
  if (member) {
    const m = await asService('POST', '/rest/v1/members', { id, full_name: `E2E ${tag}`, role: 'Member' })
    if (m.status !== 201) throw new Error(`could not add ${tag} to the roster: ${m.status}`)
  }
  const login = await http('POST', '/auth/v1/token?grant_type=password', { body: { email, password } })
  if (login.status !== 200) throw new Error(`could not sign in ${tag}: ${login.status}`)
  people[tag] = { id, token: login.json.access_token }
}

async function cleanup() {
  if (taskId) {
    // Due everything this run queued, then let the purge job remove the objects.
    await asService('DELETE', `/rest/v1/tasks?id=eq.${taskId}`)
    await asService('PATCH', `/rest/v1/attachment_purge_queue?task_id=eq.${taskId}&purged_at=is.null`, {
      purge_after: new Date(Date.now() - 1000).toISOString(),
    })
    await fn('attachment-purge', undefined, {}, { 'x-purge-secret': fnEnv.ATTACHMENTS_PURGE_SECRET })
    await asService('DELETE', `/rest/v1/attachment_purge_queue?task_id=eq.${taskId}`)
  }
  for (const p of Object.values(people)) {
    await http('DELETE', `/auth/v1/admin/users/${p.id}`, { token: SERVICE, apikey: SERVICE })
  }
}

// ------------------------------------------------------------------ the run
async function main() {
  await makeUser('owner', true)
  await makeUser('other', true)
  await makeUser('outsider', false)
  const season = await asService('GET', '/rest/v1/seasons?is_current=eq.true&select=id')
  const task = await asService('POST', '/rest/v1/tasks', { season_id: season.json[0].id, title: `E2E attachments ${run}`, owner_id: people.owner.id })
  if (task.status !== 201) throw new Error(`could not create the task: ${task.status} ${JSON.stringify(task.json)}`)
  taskId = task.json[0].id
  const photo = { taskId, kind: 'photo', mimeType: 'image/jpeg', sizeBytes: 1234, originalName: 'front wheel.jpg', width: 800, height: 600 }

  console.log('==> upload flow')
  check('without a token the gateway refuses', (await fn('attachment-upload-url', undefined, photo)).status === 401)
  const up = await fn('attachment-upload-url', people.owner.token, photo)
  check('the task owner gets signed upload URLs', up.status === 200 && up.json.upload?.url && up.json.thumbnail?.url, JSON.stringify(up.json))
  const photoId = up.json.attachmentId
  check('... valid for 5 minutes', up.json.expiresIn === 300)
  check('... bound to the content type', up.json.upload.headers['Content-Type'] === 'image/jpeg' && up.json.thumbnail.headers['Content-Type'] === 'image/webp')
  check('confirming before anything arrived answers 409, retryable', (await fn('attachment-confirm', people.owner.token, { attachmentId: photoId })).status === 409)
  const wrongType = await fetch(up.json.upload.url, { method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: bytes(1234, 7) })
  check('the bucket refuses the upload URL with another content type', wrongType.status === 403, String(wrongType.status))
  check('the file arrives with its signed URL', (await put(up.json.upload, bytes(1234, 7))) === 200)
  check('confirming with only the file (no thumbnail yet) still answers 409', (await fn('attachment-confirm', people.owner.token, { attachmentId: photoId })).status === 409)
  check('the thumbnail arrives', (await put(up.json.thumbnail, bytes(321, 9))) === 200)
  check('another member cannot finish someone else\'s upload', (await fn('attachment-confirm', people.other.token, { attachmentId: photoId })).status === 404)
  const conf = await fn('attachment-confirm', people.owner.token, { attachmentId: photoId })
  check('the uploader confirms: ready', conf.status === 200 && conf.json.status === 'ready', JSON.stringify(conf.json))
  check('confirming again is harmless', (await fn('attachment-confirm', people.owner.token, { attachmentId: photoId })).json?.status === 'ready')

  console.log('==> download flow')
  const dl = await fn('attachment-download-url', people.other.token, { attachmentIds: [photoId] })
  check('another member gets a download URL', dl.status === 200 && typeof dl.json.urls?.[photoId] === 'string')
  const got = await fetch(dl.json.urls[photoId])
  const body = new Uint8Array(await got.arrayBuffer())
  check('... which returns exactly the uploaded bytes', got.status === 200 && body.length === 1234 && body.every((b) => b === 7))
  const ranged = await fetch(dl.json.urls[photoId], { headers: { Range: 'bytes=0-99' } })
  check('... and supports range requests (video seeking)', ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 100)
  const th = await fn('attachment-download-url', people.other.token, { attachmentIds: [photoId], variant: 'thumb' })
  const thBody = await fetch(th.json.urls[photoId])
  check('the thumbnail variant returns the thumbnail', thBody.status === 200 && (await thBody.arrayBuffer()).byteLength === 321)
  const out = await fn('attachment-download-url', people.outsider.token, { attachmentIds: [photoId] })
  check('someone who is not a member gets nothing (and no hint that it exists)', out.status === 200 && Object.keys(out.json.urls).length === 0)
  check('a malformed batch is refused', (await fn('attachment-download-url', people.other.token, { attachmentIds: ['x'] })).status === 400)

  console.log('==> refusals and failures')
  const denied = await fn('attachment-upload-url', people.other.token, photo)
  check('a member who cannot edit the task cannot upload (403, database message)', denied.status === 403 && /can't attach/i.test(denied.json.error ?? ''), JSON.stringify(denied.json))
  const big = await fn('attachment-upload-url', people.owner.token, { ...photo, sizeBytes: 11 * 1024 * 1024 })
  check('a photo over 10 MiB is refused (400)', big.status === 400, JSON.stringify(big.json))
  check('a malformed request is refused (400)', (await fn('attachment-upload-url', people.owner.token, { ...photo, taskId: 'nope' })).status === 400)
  const liar = await fn('attachment-upload-url', people.owner.token, { ...photo, sizeBytes: 2000, originalName: 'liar.jpg' })
  await put(liar.json.upload, bytes(1000, 1))
  await put(liar.json.thumbnail, bytes(10, 1))
  const liarConf = await fn('attachment-confirm', people.owner.token, { attachmentId: liar.json.attachmentId })
  check('a file smaller than announced fails the upload', liarConf.status === 200 && liarConf.json.status === 'failed', JSON.stringify(liarConf.json))
  const pend = await fn('attachment-upload-url', people.owner.token, { ...photo, originalName: 'never.jpg' })
  const pendDl = await fn('attachment-download-url', people.owner.token, { attachmentIds: [pend.json.attachmentId, liar.json.attachmentId] })
  check('pending and failed files have no download URL', Object.keys(pendDl.json.urls).length === 0)

  console.log('==> documents')
  const doc = await fn('attachment-upload-url', people.owner.token, { taskId, kind: 'document', mimeType: 'application/pdf', sizeBytes: 500, originalName: 'Ölwanne plan.pdf' })
  check('a document gets an upload URL and no thumbnail URL', doc.status === 200 && doc.json.thumbnail === null)
  await put(doc.json.upload, bytes(500, 3))
  check('a document is ready without a thumbnail', (await fn('attachment-confirm', people.owner.token, { attachmentId: doc.json.attachmentId })).json?.status === 'ready')
  const docDl = await fn('attachment-download-url', people.other.token, { attachmentIds: [doc.json.attachmentId] })
  check('a document URL asks the browser to save it under its name', new URL(docDl.json.urls[doc.json.attachmentId]).searchParams.get('response-content-disposition')?.includes("UTF-8''%C3%96lwanne%20plan.pdf"))
  check('... and still downloads', (await fetch(docDl.json.urls[doc.json.attachmentId])).status === 200)

  console.log('==> delete and purge')
  const keys = await asService('GET', `/rest/v1/task_attachments?id=eq.${photoId}&select=object_key,thumb_key`)
  const [{ object_key: photoKey, thumb_key: thumbKey }] = keys.json
  const del = await http('POST', '/rest/v1/rpc/delete_attachment', { token: people.owner.token, body: { p_attachment_id: photoId } })
  check('the uploader deletes the photo', del.status === 200 && del.json === true, JSON.stringify(del.json))
  check('a deleted file has no download URL', Object.keys((await fn('attachment-download-url', people.other.token, { attachmentIds: [photoId] })).json.urls).length === 0)
  check('... but its objects are still in the bucket (30-day grace)', (await headObject(photoKey)) === 200)
  check('the purge job refuses a wrong secret', (await fn('attachment-purge', undefined, {}, { 'x-purge-secret': 'x'.repeat(64) })).status === 401)
  check('the purge job refuses no secret', (await fn('attachment-purge', undefined, {})).status === 401)
  check('the purge job refuses a member token', (await fn('attachment-purge', people.owner.token, {})).status === 401)
  await asService('PATCH', `/rest/v1/attachment_purge_queue?attachment_id=eq.${photoId}`, { purge_after: new Date(Date.now() - 1000).toISOString() })
  const purge = await fn('attachment-purge', undefined, {}, { 'x-purge-secret': fnEnv.ATTACHMENTS_PURGE_SECRET })
  check('the purge job deletes what is due', purge.status === 200 && purge.json.purged >= 2 && purge.json.failed === 0, JSON.stringify(purge.json))
  check('... the photo is gone from the bucket', (await headObject(photoKey)) === 404)
  check('... and its thumbnail', (await headObject(thumbKey)) === 404)
  const q = await asService('GET', `/rest/v1/attachment_purge_queue?attachment_id=eq.${photoId}&select=purged_at`)
  check('... and the queue entry is marked purged', q.json.length === 1 && q.json[0].purged_at !== null)
  const again = await fn('attachment-purge', undefined, {}, { 'x-purge-secret': fnEnv.ATTACHMENTS_PURGE_SECRET })
  check('a second run finds nothing more for this file', again.status === 200 && again.json.failed === 0)
}

try {
  await main()
} catch (e) {
  check('the run completed', false, String(e?.message ?? e))
} finally {
  await cleanup()
}
const failed = results.filter((r) => !r.ok)
console.log(`==> ${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
