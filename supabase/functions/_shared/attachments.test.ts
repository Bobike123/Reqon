import { describe, expect, it, vi } from 'vitest'
import {
  contentDisposition,
  deleteObject,
  headObject,
  isObjectKey,
  mapDbError,
  objectUrl,
  parseAttachmentId,
  parseDownloadRequest,
  parseUploadRequest,
  presignGet,
  presignPut,
  reply,
  safeEqual,
  storageConfig,
} from './attachments.ts'

const T = '11111111-1111-4111-8111-111111111111'
const A = '22222222-2222-4222-8222-222222222222'
const KEY = `tasks/${T}/${A}.jpg`

const ENV: Record<string, string> = {
  ATTACHMENTS_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/',
  ATTACHMENTS_S3_BUCKET: 'sdumotoclub',
  ATTACHMENTS_S3_ACCESS_KEY_ID: 'AKID',
  ATTACHMENTS_S3_SECRET_ACCESS_KEY: 'SECRET',
}
const cfg = storageConfig((n) => ENV[n])!

describe('storageConfig', () => {
  it('reads R2 settings, trims the trailing slash, defaults region auto and public = server endpoint', () => {
    expect(cfg).toEqual({
      creds: { accessKeyId: 'AKID', secretAccessKey: 'SECRET', region: 'auto' },
      bucket: 'sdumotoclub',
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      publicEndpoint: 'https://acct.r2.cloudflarestorage.com',
    })
  })
  it('keeps a separate public endpoint (local stack: container vs browser address)', () => {
    const local = storageConfig((n) => ({ ...ENV, ATTACHMENTS_S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:54321/storage/v1/s3', ATTACHMENTS_S3_REGION: 'local' })[n])!
    expect(local.publicEndpoint).toBe('http://127.0.0.1:54321/storage/v1/s3')
    expect(local.creds.region).toBe('local')
  })
  it('is null when anything is missing or malformed', () => {
    for (const drop of Object.keys(ENV)) {
      expect(storageConfig((n) => (n === drop ? undefined : ENV[n]))).toBeNull()
    }
    expect(storageConfig((n) => ({ ...ENV, ATTACHMENTS_S3_ENDPOINT: 'ftp://x' })[n])).toBeNull()
    expect(storageConfig((n) => ({ ...ENV, ATTACHMENTS_S3_BUCKET: 'Bad_Bucket' })[n])).toBeNull()
  })
})

describe('object keys', () => {
  it('accepts only keys the database builds', () => {
    expect(isObjectKey(KEY)).toBe(true)
    expect(isObjectKey(`tasks/${T}/${A}.thumb.webp`)).toBe(true)
    expect(isObjectKey(`tasks/${T}/${A}.exe`)).toBe(false)
    expect(isObjectKey(`tasks/${T}/../${A}.jpg`)).toBe(false)
    expect(isObjectKey(`backups/${A}.jpg`)).toBe(false)
    expect(isObjectKey(42)).toBe(false)
  })
  it('builds path-style URLs and refuses foreign keys', () => {
    expect(objectUrl('https://e', 'b', KEY)).toBe(`https://e/b/${KEY}`)
    expect(() => objectUrl('https://e', 'b', '../secrets')).toThrow()
  })
})

describe('signed URLs', () => {
  it('a PUT is bound to its content type and lives 5 minutes', async () => {
    const q = new URL(await presignPut(cfg, KEY, 'image/jpeg')).searchParams
    expect(q.get('X-Amz-SignedHeaders')).toBe('content-type;host')
    expect(q.get('X-Amz-Expires')).toBe('300')
  })
  it('a GET lives an hour, and can carry a save-as name', async () => {
    const plain = new URL(await presignGet(cfg, KEY))
    expect(plain.searchParams.get('X-Amz-Expires')).toBe('3600')
    expect(plain.searchParams.has('response-content-disposition')).toBe(false)
    const named = new URL(await presignGet(cfg, KEY, 'Motor "v2".pdf'))
    expect(named.searchParams.get('response-content-disposition')).toBe(contentDisposition('Motor "v2".pdf'))
  })
  it('content disposition escapes quotes and keeps the UTF-8 name', () => {
    expect(contentDisposition('Ölwanne "neu".pdf')).toBe(
      `attachment; filename="_lwanne _neu_.pdf"; filename*=UTF-8''%C3%96lwanne%20%22neu%22.pdf`,
    )
  })
})

describe('HEAD and DELETE', () => {
  it('HEAD reports size and normalised type, and sends a signed request', async () => {
    const f = vi.fn(async () => new Response(null, { status: 200, headers: { 'content-length': '1234', 'content-type': 'Image/JPEG; charset=binary' } }))
    expect(await headObject(cfg, KEY, f as unknown as typeof fetch)).toEqual({ exists: true, size: 1234, contentType: 'image/jpeg', status: 200 })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://acct.r2.cloudflarestorage.com/sdumotoclub/${KEY}`)
    expect(init.method).toBe('HEAD')
    expect((init.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\//)
  })
  it('HEAD of a missing object is not an error', async () => {
    const f = vi.fn(async () => new Response(null, { status: 404 }))
    expect((await headObject(cfg, KEY, f as unknown as typeof fetch)).exists).toBe(false)
  })
  it('HEAD failing otherwise throws (the caller answers 502)', async () => {
    const f = vi.fn(async () => new Response(null, { status: 403 }))
    await expect(headObject(cfg, KEY, f as unknown as typeof fetch)).rejects.toThrow('403')
  })
  it('DELETE treats 204 and 404 as done, anything else as not done', async () => {
    for (const [status, done] of [[204, true], [200, true], [404, true], [403, false], [500, false]] as const) {
      const f = vi.fn(async () => new Response(null, { status }))
      expect(await deleteObject(cfg, KEY, f as unknown as typeof fetch)).toBe(done)
    }
  })
})

describe('request parsing', () => {
  const good = { taskId: T, kind: 'video', mimeType: 'video/mp4', sizeBytes: 5000, originalName: 'ride.mp4', width: 1280, height: 720, durationMs: 30000 }
  it('accepts a full request and defaults playable', () => {
    expect(parseUploadRequest(good)).toEqual({ ...good, playable: true, thumbMimeType: 'image/webp' })
    expect(parseUploadRequest({ ...good, thumbMimeType: 'image/jpeg' })).toMatchObject({ thumbMimeType: 'image/jpeg' })
    expect(parseUploadRequest({ ...good, thumbMimeType: 'image/png' })).toBe('thumbMimeType must be image/webp or image/jpeg.')
    expect(parseUploadRequest({ ...good, width: undefined, height: null, durationMs: undefined, playable: false })).toMatchObject({ width: null, height: null, durationMs: null, playable: false })
  })
  it.each([
    [null, 'Send a JSON body.'],
    [{ ...good, taskId: 'x' }, 'taskId'],
    [{ ...good, kind: 'audio' }, 'kind'],
    [{ ...good, mimeType: 'text/html; x' }, 'mimeType'],
    [{ ...good, sizeBytes: 0 }, 'sizeBytes'],
    [{ ...good, sizeBytes: 104857601 }, 'sizeBytes'],
    [{ ...good, sizeBytes: 1.5 }, 'sizeBytes'],
    [{ ...good, originalName: '' }, 'originalName'],
    [{ ...good, width: 0 }, 'width'],
    [{ ...good, durationMs: -1 }, 'durationMs'],
    [{ ...good, playable: 'yes' }, 'playable'],
  ])('refuses %j', (input, message) => {
    expect(parseUploadRequest(input)).toEqual(expect.stringContaining(message))
  })
  it('reads an attachment id', () => {
    expect(parseAttachmentId({ attachmentId: A.toUpperCase() })).toBe(A)
    expect(parseAttachmentId({ attachmentId: 'nope' })).toBeNull()
    expect(parseAttachmentId('x')).toBeNull()
  })
  it('reads a download batch, de-duplicating ids', () => {
    expect(parseDownloadRequest({ attachmentIds: [A, A.toUpperCase()] })).toEqual({ ids: [A], variant: 'original', download: false })
    expect(parseDownloadRequest({ attachmentIds: [A], variant: 'thumb', download: true })).toEqual({ ids: [A], variant: 'thumb', download: true })
    expect(parseDownloadRequest({ attachmentIds: [] })).toEqual(expect.stringContaining('1 to 60'))
    expect(parseDownloadRequest({ attachmentIds: Array(61).fill(A) })).toEqual(expect.stringContaining('1 to 60'))
    expect(parseDownloadRequest({ attachmentIds: ['x'] })).toEqual(expect.stringContaining('ids'))
    expect(parseDownloadRequest({ attachmentIds: [A], variant: 'poster' })).toEqual(expect.stringContaining('variant'))
    expect(parseDownloadRequest({ attachmentIds: [A], download: 1 })).toEqual(expect.stringContaining('download'))
    expect(parseDownloadRequest(null)).toBe('Send a JSON body.')
  })
})

describe('replies and errors', () => {
  it('maps the database SQLSTATEs to HTTP and passes the friendly message through', () => {
    expect(mapDbError({ code: '42501', message: 'no' })).toEqual({ status: 403, error: 'no' })
    expect(mapDbError({ code: 'P0002', message: 'gone' })).toEqual({ status: 404, error: 'gone' })
    expect(mapDbError({ code: '23514', message: 'too big' })).toEqual({ status: 400, error: 'too big' })
    expect(mapDbError({ code: '22023', message: 'bad' }).status).toBe(400)
    expect(mapDbError({ code: '54000', message: 'full' })).toEqual({ status: 409, error: 'full' })
  })
  it('never echoes an unexpected database error', () => {
    expect(mapDbError({ code: 'XX000', message: 'internal detail' })).toEqual({ status: 500, error: 'Something went wrong. Nothing was changed.' })
    expect(mapDbError(null).status).toBe(500)
  })
  it('replies JSON with CORS and no caching', async () => {
    const r = reply(201, { a: 1 })
    expect(r.status).toBe(201)
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.json()).toEqual({ a: 1 })
  })
  it('compares secrets in constant time semantics', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', 'x')).toBe(false)
  })
})
