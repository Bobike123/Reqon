// backup-record — the backup workflow tells the app what happened (Ultraplan Phase 4; BAK-09).
//
// Not reachable with a member's token: the gateway's JWT check is off for this function
// (supabase/config.toml) and the ONLY accepted credential is the shared secret BACKUP_RECORD_SECRET in the
// `x-backup-secret` header, compared in constant time (decision D-22: the workflow never holds the
// service-role key). The secret can only add a row to backup_runs through record_backup_run().
//
// Request:  POST { destination: 'r2'|'github'|'drive', ok, taken_at, object_key?, size_bytes?, sha256?,
//                  migration_version?, db_size_bytes?, row_count?, recipients?: string[], detail? }
// Response: 200 { id } | 400 { error } | 401 | 5xx { error }

import { reply, safeEqual } from '../_shared/attachments.ts'
import { parseBackupRecord } from '../_shared/backups.ts'
import { jsonBody, service } from '../_shared/clients.ts'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  const secret = Deno.env.get('BACKUP_RECORD_SECRET') ?? ''
  if (secret.length < 32) return reply(500, { error: 'Backup recording is not configured.' })
  if (!safeEqual(req.headers.get('x-backup-secret') ?? '', secret)) return reply(401, { error: 'Not allowed.' })

  const input = parseBackupRecord(await jsonBody(req))
  if (typeof input === 'string') return reply(400, { error: input })
  const admin = service()
  if (admin instanceof Response) return admin

  const { data, error } = await admin.rpc('record_backup_run', {
    p_destination: input.destination,
    p_taken_at: input.takenAt,
    p_ok: input.ok,
    p_object_key: input.objectKey,
    p_size_bytes: input.sizeBytes,
    p_sha256: input.sha256,
    p_migration_version: input.migrationVersion,
    p_db_size_bytes: input.dbSizeBytes,
    p_row_count: input.rowCount,
    p_recipients: input.recipients,
    p_detail: input.detail,
  })
  if (error) {
    // 23514: a table CHECK refused the record (e.g. an ok run without a checksum).
    if (error.code === '23514') return reply(400, { error: 'The record was refused: ' + (error.message ?? 'it breaks a rule') })
    console.error('backup-record: failed', error.code)
    return reply(500, { error: 'Something went wrong. Nothing was recorded.' })
  }
  console.log('backup-record:', input.destination, input.ok ? 'ok' : 'failed')
  return reply(200, { id: data })
})
