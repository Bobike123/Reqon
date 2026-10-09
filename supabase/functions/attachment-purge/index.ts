// attachment-purge — deletes from the bucket every object whose time has come (Ultraplan Phase 2,
// consumed by the scheduled workflow of Phase 4; requirement ATT-10/ATT-23).
//
// Not reachable with a member's token: the gateway's JWT check is off for this function
// (supabase/config.toml) and the ONLY accepted credential is the shared secret
// ATTACHMENTS_PURGE_SECRET in the `x-purge-secret` header, compared in constant time. That secret is
// narrower than the service-role key: with it, a caller can only make this function delete objects
// the database already queued as due (list_due_attachment_purges) — nothing else.
//
// Each queue entry is marked purged only when ALL its objects are gone (a missing object counts as
// gone), so a failed DELETE is simply retried on the next run.
//
// Request:  POST {}  with header x-purge-secret
// Response: 200 { purged, failed, remaining } | 401 | 5xx { error }

import { deleteObject, isObjectKey, reply, safeEqual } from '../_shared/attachments.ts'
import { bucket, service } from '../_shared/clients.ts'

const BATCH = 100

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  const secret = Deno.env.get('ATTACHMENTS_PURGE_SECRET') ?? ''
  if (secret.length < 32) return reply(500, { error: 'The purge job is not configured.' })
  if (!safeEqual(req.headers.get('x-purge-secret') ?? '', secret)) return reply(401, { error: 'Not allowed.' })

  const cfg = bucket()
  if (cfg instanceof Response) return cfg
  const admin = service()
  if (admin instanceof Response) return admin

  const { data: due, error } = await admin.rpc('list_due_attachment_purges', { p_limit: BATCH })
  if (error) {
    console.error('attachment-purge: listing failed', error.code)
    return reply(500, { error: 'Could not read the purge queue.' })
  }

  const done: number[] = []
  let failed = 0
  for (const entry of (due ?? []) as { id: number; object_keys: string[] }[]) {
    let ok = true
    for (const key of entry.object_keys) {
      if (!isObjectKey(key)) {
        ok = false
        console.error('attachment-purge: refusing unexpected key in entry', entry.id)
        break
      }
      try {
        if (!(await deleteObject(cfg, key))) ok = false
      } catch {
        ok = false
      }
    }
    if (ok) done.push(entry.id)
    else failed++
  }

  let purged = 0
  if (done.length > 0) {
    const { data, error: markError } = await admin.rpc('mark_attachment_purged', { p_ids: done })
    if (markError) {
      console.error('attachment-purge: marking failed', markError.code)
      return reply(500, { error: 'Objects were deleted but the queue could not be updated; the next run repeats it safely.' })
    }
    purged = data ?? 0
  }
  console.log('attachment-purge: purged', purged, 'failed', failed)
  return reply(200, { purged, failed, remaining: (due?.length ?? 0) === BATCH })
})
