// attachment-confirm — step 2 of an upload (Ultraplan Phase 2; ARCHITECTURE.md section 4).
//
// After the browser PUT the file (and its thumbnail), it asks to finish. This function measures the
// objects ITSELF with signed HEAD requests and hands those facts to confirm_attachment(), which is
// service-only (DECISIONS.md D-16): the browser can never claim a size or type.
//
//   * caller identity: checked with the Auth server; passed as p_uploader, and the database refuses
//     anyone but the member who started the upload;
//   * object not in the bucket yet (either the file or its thumbnail): 409, the row stays pending —
//     the browser may retry the PUT while its URL is valid; after an hour the sweep fails the row;
//   * size or type differ from the reservation: the database marks the row failed and queues the
//     objects for deletion; the reply says so.
//
// Request:  POST { attachmentId }
// Response: 200 { status: 'ready' | 'failed' | 'deleted' } | 409 { error, retry: true } | 4xx/5xx { error }

import { corsHeaders, headObject, isObjectKey, mapDbError, parseAttachmentId, reply } from '../_shared/attachments.ts'
import { bucket, caller, jsonBody, service } from '../_shared/clients.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })

  const cfg = bucket()
  if (cfg instanceof Response) return cfg
  const who = await caller(req)
  if (who instanceof Response) return who
  const admin = service()
  if (admin instanceof Response) return admin

  const id = parseAttachmentId(await jsonBody(req))
  if (!id) return reply(400, { error: 'attachmentId must be an attachment id.' })

  // A pending row is invisible to members (RLS), so it is read with the service client — and
  // then only answered to the member who started it.
  const { data: row, error } = await admin
    .from('task_attachments')
    .select('id, object_key, thumb_key, status, uploaded_by')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    console.error('attachment-confirm: lookup failed', error.code)
    return reply(500, { error: 'Something went wrong. Nothing was changed.' })
  }
  if (!row || row.uploaded_by !== who.user.id) return reply(404, { error: 'That upload does not exist.' })
  if (row.status !== 'pending') return reply(200, { status: row.status })
  if (!isObjectKey(row.object_key) || (row.thumb_key !== null && !isObjectKey(row.thumb_key))) {
    console.error('attachment-confirm: unexpected object key on', row.id)
    return reply(500, { error: 'Something went wrong. Nothing was changed.' })
  }

  let file, thumb
  try {
    file = await headObject(cfg, row.object_key)
    thumb = row.thumb_key ? await headObject(cfg, row.thumb_key) : null
  } catch (e) {
    console.error('attachment-confirm: storage HEAD failed', String(e))
    return reply(502, { error: 'File storage did not answer. Try again.' })
  }
  if (!file.exists || (thumb !== null && !thumb.exists)) {
    return reply(409, { error: 'The file has not arrived yet. Upload it, then try again.', retry: true })
  }

  const { data: status, error: confirmError } = await admin.rpc('confirm_attachment', {
    p_attachment_id: row.id,
    p_uploader: who.user.id,
    p_actual_size: file.size,
    p_actual_mime: file.contentType,
    p_thumb_present: thumb === null ? false : thumb.exists,
  })
  if (confirmError) {
    const mapped = mapDbError(confirmError)
    if (mapped.status === 500) console.error('attachment-confirm: confirm failed', confirmError.code)
    return reply(mapped.status, { error: mapped.error })
  }
  console.log('attachment-confirm:', row.id, status)
  return reply(200, {
    status,
    ...(status === 'failed' ? { error: 'The uploaded file did not match what was announced. Upload it again.' } : {}),
  })
})
