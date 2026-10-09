// attachment-download-url — signed GET URLs for files a member may see (Ultraplan Phase 2;
// ARCHITECTURE.md section 6).
//
// The rows are read AS THE CALLER, so RLS (is_member(), status ready/deleted) decides what exists for
// them; this function additionally answers only `ready` rows. Ids the caller cannot see are simply
// absent from the reply — the response never says whether a hidden id exists.
//
// Request:  POST { attachmentIds: uuid[1..60], variant?: 'original' | 'thumb', download?: boolean }
//   variant 'thumb'     the photo thumbnail / video poster (rows without one are skipped)
//   download true       the URL makes the browser save the file under its original name
//                       (documents and download-only videos always do)
// Response: 200 { expiresIn, urls: { [attachmentId]: string } } | 4xx/5xx { error }

import { corsHeaders, DOWNLOAD_URL_TTL, isObjectKey, parseDownloadRequest, presignGet, reply } from '../_shared/attachments.ts'
import { bucket, caller, jsonBody } from '../_shared/clients.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })

  const cfg = bucket()
  if (cfg instanceof Response) return cfg
  const who = await caller(req)
  if (who instanceof Response) return who

  const input = parseDownloadRequest(await jsonBody(req))
  if (typeof input === 'string') return reply(400, { error: input })

  const { data: rows, error } = await who.client
    .from('task_attachments')
    .select('id, kind, object_key, thumb_key, original_name, playable, status')
    .in('id', input.ids)
    .eq('status', 'ready')
  if (error) {
    console.error('attachment-download-url: lookup failed', error.code)
    return reply(500, { error: 'Something went wrong.' })
  }

  const urls: Record<string, string> = {}
  for (const row of rows ?? []) {
    const key = input.variant === 'thumb' ? row.thumb_key : row.object_key
    if (!isObjectKey(key)) continue
    const saveAs =
      input.variant === 'original' && (input.download || row.kind === 'document' || !row.playable)
        ? row.original_name
        : undefined
    urls[row.id] = await presignGet(cfg, key, saveAs)
  }
  return reply(200, { expiresIn: DOWNLOAD_URL_TTL, urls })
})
