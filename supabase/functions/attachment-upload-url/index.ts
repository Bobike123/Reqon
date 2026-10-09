// attachment-upload-url — step 1 of an upload (Ultraplan Phase 2; ARCHITECTURE.md section 4).
//
// The caller asks to attach one file to a task. request_attachment_upload() runs AS THE CALLER and
// decides everything (may they edit the task, type and size limits, video length, pending cap,
// quota); it reserves a `pending` row and returns the object keys. This function only turns those
// keys into short-lived signed PUT URLs: the file goes straight from the browser to the bucket.
//
// Request:  POST { taskId, kind, mimeType, sizeBytes, originalName, width?, height?, durationMs?, playable?,
//                 thumbMimeType?: 'image/webp' (default) | 'image/jpeg' }
// Response: 200 { attachmentId, expiresIn,
//                 upload:    { url, method: 'PUT', headers: { 'Content-Type': mimeType } },
//                 thumbnail: { url, method: 'PUT', headers: { 'Content-Type': thumbMimeType } } | null }
//           4xx/5xx { error }
// The PUT must send exactly that Content-Type (it is part of the signature); then call attachment-confirm.

import { corsHeaders, mapDbError, parseUploadRequest, presignPut, reply, UPLOAD_URL_TTL } from '../_shared/attachments.ts'
import { bucket, caller, jsonBody } from '../_shared/clients.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })

  const cfg = bucket()
  if (cfg instanceof Response) return cfg
  const who = await caller(req)
  if (who instanceof Response) return who

  const input = parseUploadRequest(await jsonBody(req))
  if (typeof input === 'string') return reply(400, { error: input })

  const { data, error } = await who.client.rpc('request_attachment_upload', {
    p_task_id: input.taskId,
    p_kind: input.kind,
    p_mime_type: input.mimeType,
    p_size_bytes: input.sizeBytes,
    p_original_name: input.originalName,
    p_width: input.width,
    p_height: input.height,
    p_duration_ms: input.durationMs,
    p_playable: input.playable,
  })
  if (error) {
    const mapped = mapDbError(error)
    if (mapped.status === 500) console.error('attachment-upload-url: request failed', error.code)
    return reply(mapped.status, { error: mapped.error })
  }
  const row = Array.isArray(data) ? data[0] : data
  if (!row?.attachment_id || !row?.object_key) {
    console.error('attachment-upload-url: request returned no row')
    return reply(500, { error: 'Something went wrong. Nothing was changed.' })
  }

  const uploadUrl = await presignPut(cfg, row.object_key, input.mimeType)
  const thumbUrl = row.thumb_key ? await presignPut(cfg, row.thumb_key, input.thumbMimeType) : null

  console.log('attachment-upload-url: reserved', row.attachment_id, 'by', who.user.id)
  return reply(200, {
    attachmentId: row.attachment_id,
    expiresIn: UPLOAD_URL_TTL,
    upload: { url: uploadUrl, method: 'PUT', headers: { 'Content-Type': input.mimeType } },
    thumbnail: thumbUrl ? { url: thumbUrl, method: 'PUT', headers: { 'Content-Type': input.thumbMimeType } } : null,
  })
})
