// backup-download-url — a signed link to the newest backup in R2, for the Board (Ultraplan Phase 4; BAK-09).
//
// The newest successful R2 record is read AS THE CALLER: backup_runs is readable by is_admin() only
// (President, Vice President, Developer), so RLS decides who gets a link; anyone else sees no row and is
// told there is nothing for them. The file is age-encrypted; the link alone discloses nothing.
//
// Request:  POST {}
// Response: 200 { url, expiresIn, name, sizeBytes, sha256, takenAt } | 404 { error } | 4xx/5xx { error }

import { corsHeaders, reply } from '../_shared/attachments.ts'
import { BACKUP_URL_TTL, isBackupKey, presignBackupGet } from '../_shared/backups.ts'
import { backupBucket, caller } from '../_shared/clients.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })

  const cfg = backupBucket()
  if (cfg instanceof Response) return cfg
  const who = await caller(req)
  if (who instanceof Response) return who

  const { data, error } = await who.client
    .from('backup_runs')
    .select('object_key, size_bytes, sha256, taken_at')
    .eq('destination', 'r2')
    .eq('ok', true)
    .not('object_key', 'is', null)
    .order('taken_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('backup-download-url: lookup failed', error.code)
    return reply(500, { error: 'Something went wrong.' })
  }
  if (!data || !isBackupKey(data.object_key)) {
    return reply(404, { error: 'There is no backup you can download. Only the President, the Vice President and Developers can, once a backup has run.' })
  }
  const url = await presignBackupGet(cfg, data.object_key)
  console.log('backup-download-url: issued for', who.user.id)
  return reply(200, {
    url,
    expiresIn: BACKUP_URL_TTL,
    name: data.object_key.slice(data.object_key.lastIndexOf('/') + 1),
    sizeBytes: data.size_bytes,
    sha256: data.sha256,
    takenAt: data.taken_at,
  })
})
