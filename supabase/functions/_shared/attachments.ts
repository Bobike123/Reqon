// Shared, runtime-neutral logic of the attachment Edge Functions (Ultraplan Phase 2): configuration,
// object URLs, request parsing, error mapping and replies. No Deno or npm imports here, so Vitest
// covers it (attachments.test.ts); the Deno-only parts live in each function's index.ts.
//
// Trust model (docs/ultraplan/DECISIONS.md D-16):
//   * every database decision is made by the Phase 1 functions, called AS THE CALLER where the
//     caller's identity matters (request_attachment_upload, reading ready rows);
//   * confirm_attachment is service-only and is given what THIS code measured on the bucket;
//   * the bucket keys never leave the function: the browser only ever gets short-lived signed URLs.

import { type Credentials, presignUrl, signRequest, uriEncode } from './sigv4.ts'

export const UPLOAD_URL_TTL = 300 // seconds a browser has to start a PUT
export const DOWNLOAD_URL_TTL = 3600 // seconds a GET URL stays valid (a long video keeps playing)
export const MAX_DOWNLOAD_BATCH = 60
export const MAX_VIDEO_BYTES = 104857600

export type StorageConfig = {
  creds: Credentials
  bucket: string
  endpoint: string // used by the function itself (HEAD, DELETE)
  publicEndpoint: string // used in URLs handed to browsers
}

// Reads the bucket configuration through a getter (Deno.env.get in the functions, a map in tests).
export function storageConfig(get: (name: string) => string | undefined): StorageConfig | null {
  const endpoint = get('ATTACHMENTS_S3_ENDPOINT')?.replace(/\/+$/, '')
  const bucket = get('ATTACHMENTS_S3_BUCKET')
  const accessKeyId = get('ATTACHMENTS_S3_ACCESS_KEY_ID')
  const secretAccessKey = get('ATTACHMENTS_S3_SECRET_ACCESS_KEY')
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  if (!/^https?:\/\//.test(endpoint) || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)) return null
  return {
    creds: { accessKeyId, secretAccessKey, region: get('ATTACHMENTS_S3_REGION') || 'auto' },
    bucket,
    endpoint,
    publicEndpoint: get('ATTACHMENTS_S3_PUBLIC_ENDPOINT')?.replace(/\/+$/, '') || endpoint,
  }
}

// Keys come from the database (built from uuids by request_attachment_upload); refuse anything else
// so a bad row can never address another part of the bucket.
const KEY = /^tasks\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:thumb\.webp|webp|jpg|png|pdf|mp4|mov|webm)$/

export function isObjectKey(key: unknown): key is string {
  return typeof key === 'string' && KEY.test(key)
}

export function objectUrl(base: string, bucket: string, key: string): string {
  if (!isObjectKey(key)) throw new Error('not an attachment object key')
  return `${base}/${bucket}/${uriEncode(key, true)}`
}

export function presignPut(cfg: StorageConfig, key: string, contentType: string, now?: Date) {
  return presignUrl(cfg.creds, {
    method: 'PUT',
    url: objectUrl(cfg.publicEndpoint, cfg.bucket, key),
    expiresIn: UPLOAD_URL_TTL,
    signedHeaders: { 'content-type': contentType },
    now,
  })
}

export function presignGet(cfg: StorageConfig, key: string, downloadName?: string, now?: Date) {
  return presignUrl(cfg.creds, {
    method: 'GET',
    url: objectUrl(cfg.publicEndpoint, cfg.bucket, key),
    expiresIn: DOWNLOAD_URL_TTL,
    query: downloadName ? { 'response-content-disposition': contentDisposition(downloadName) } : undefined,
    now,
  })
}

export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${uriEncode(name)}`
}

export type HeadResult = { exists: boolean; size: number | null; contentType: string | null; status: number }

// HEAD an object as the function. `fetchImpl` is injectable for tests.
export async function headObject(cfg: StorageConfig, key: string, fetchImpl: typeof fetch = fetch): Promise<HeadResult> {
  const url = objectUrl(cfg.endpoint, cfg.bucket, key)
  const res = await fetchImpl(url, { method: 'HEAD', headers: await signRequest(cfg.creds, { method: 'HEAD', url }) })
  if (res.status === 404) return { exists: false, size: null, contentType: null, status: 404 }
  if (!res.ok) throw new Error(`HEAD failed with ${res.status}`)
  const length = res.headers.get('content-length')
  const type = res.headers.get('content-type')
  return {
    exists: true,
    size: length !== null && /^\d+$/.test(length) ? Number(length) : null,
    contentType: type ? type.split(';')[0].trim().toLowerCase() : null,
    status: res.status,
  }
}

// DELETE an object as the function. A missing object counts as deleted (idempotent).
export async function deleteObject(cfg: StorageConfig, key: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const url = objectUrl(cfg.endpoint, cfg.bucket, key)
  const res = await fetchImpl(url, { method: 'DELETE', headers: await signRequest(cfg.creds, { method: 'DELETE', url }) })
  return res.ok || res.status === 404
}

// ------------------------------------------------------------------- request bodies
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v)
}

function optionalInt(v: unknown, min: number, max: number): number | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return undefined
  return v
}

export type UploadRequest = {
  taskId: string
  kind: 'photo' | 'document' | 'video'
  mimeType: string
  sizeBytes: number
  originalName: string
  width: number | null
  height: number | null
  durationMs: number | null
  playable: boolean
  // What the thumbnail/poster really is: WebP where the browser can encode it, JPEG on Safari
  // (DECISIONS.md D-26). The key keeps its .thumb.webp name; the stored Content-Type is the truth.
  thumbMimeType: 'image/webp' | 'image/jpeg'
}

// Shape checks only; every rule (types per kind, limits, quota, permission) is the database's.
export function parseUploadRequest(raw: unknown): UploadRequest | string {
  if (typeof raw !== 'object' || raw === null) return 'Send a JSON body.'
  const b = raw as Record<string, unknown>
  if (!isUuid(b.taskId)) return 'taskId must be a task id.'
  if (b.kind !== 'photo' && b.kind !== 'document' && b.kind !== 'video') return 'kind must be photo, document or video.'
  if (typeof b.mimeType !== 'string' || !/^[a-z]+\/[a-z0-9.+-]{1,80}$/.test(b.mimeType)) return 'mimeType is not a content type.'
  if (typeof b.sizeBytes !== 'number' || !Number.isInteger(b.sizeBytes) || b.sizeBytes < 1 || b.sizeBytes > MAX_VIDEO_BYTES) {
    return 'sizeBytes must be a whole number of bytes.'
  }
  if (typeof b.originalName !== 'string' || b.originalName.length < 1 || b.originalName.length > 255) {
    return 'originalName must be 1 to 255 characters.'
  }
  const width = optionalInt(b.width, 1, 20000)
  const height = optionalInt(b.height, 1, 20000)
  const durationMs = optionalInt(b.durationMs, 1, 24 * 3600 * 1000)
  if (width === undefined || height === undefined) return 'width and height must be whole pixels.'
  if (durationMs === undefined) return 'durationMs must be a whole number of milliseconds.'
  if (b.playable !== undefined && typeof b.playable !== 'boolean') return 'playable must be true or false.'
  const thumbMimeType = b.thumbMimeType ?? 'image/webp'
  if (thumbMimeType !== 'image/webp' && thumbMimeType !== 'image/jpeg') return 'thumbMimeType must be image/webp or image/jpeg.'
  return {
    taskId: b.taskId,
    kind: b.kind,
    mimeType: b.mimeType,
    sizeBytes: b.sizeBytes,
    originalName: b.originalName,
    width,
    height,
    durationMs,
    playable: b.playable ?? true,
    thumbMimeType,
  }
}

export function parseAttachmentId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const id = (raw as Record<string, unknown>).attachmentId
  return isUuid(id) ? id.toLowerCase() : null
}

export type DownloadRequest = { ids: string[]; variant: 'original' | 'thumb'; download: boolean }

export function parseDownloadRequest(raw: unknown): DownloadRequest | string {
  if (typeof raw !== 'object' || raw === null) return 'Send a JSON body.'
  const b = raw as Record<string, unknown>
  if (!Array.isArray(b.attachmentIds) || b.attachmentIds.length < 1 || b.attachmentIds.length > MAX_DOWNLOAD_BATCH) {
    return `attachmentIds must list 1 to ${MAX_DOWNLOAD_BATCH} ids.`
  }
  if (!b.attachmentIds.every(isUuid)) return 'attachmentIds must be attachment ids.'
  const variant = b.variant ?? 'original'
  if (variant !== 'original' && variant !== 'thumb') return 'variant must be original or thumb.'
  if (b.download !== undefined && typeof b.download !== 'boolean') return 'download must be true or false.'
  return {
    ids: [...new Set((b.attachmentIds as string[]).map((s) => s.toLowerCase()))],
    variant,
    download: b.download === true,
  }
}

// --------------------------------------------------------------------- replies
export const corsHeaders = {
  // A bearer token, not a cookie, carries the caller's identity, so a wildcard origin cannot be
  // used to act as someone else (same reasoning as create-member).
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

// The Phase 1 functions raise user-facing messages with these SQLSTATEs; pass those through.
// Anything else is an internal failure and is not echoed.
export function mapDbError(err: { code?: string; message?: string } | null | undefined): { status: number; error: string } {
  const code = err?.code ?? ''
  const message = err?.message ?? ''
  switch (code) {
    case '42501':
      return { status: 403, error: message || 'You are not allowed to do that.' }
    case 'P0002':
      return { status: 404, error: message || 'Not found.' }
    case '22023':
    case '22004':
    case '23514':
      return { status: 400, error: message || 'The request was refused.' }
    case '54000':
      return { status: 409, error: message || 'A limit was reached.' }
    default:
      return { status: 500, error: 'Something went wrong. Nothing was changed.' }
  }
}

// Constant-time comparison for the purge secret.
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
