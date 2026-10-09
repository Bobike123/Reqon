// Shared, runtime-neutral logic of the backup Edge Functions (Ultraplan Phase 4): the backups bucket's
// configuration, object keys, signed download URLs and the shape of a status record. No Deno or npm
// imports, so Vitest covers it (backups.test.ts); the Deno-only parts live in each function's index.ts.
//
// The backups bucket is NOT the attachments bucket: separate bucket, separate token, separate settings
// (BACKUPS_S3_*). The browser never sees a key; the Board gets a short-lived signed GET for the encrypted
// file, which is useless without one of the recipients' private keys.

import { type Credentials, presignUrl, uriEncode } from './sigv4.ts'

export const BACKUP_URL_TTL = 600 // seconds a signed download link lives

export type BackupStorage = { creds: Credentials; bucket: string; publicEndpoint: string }

export function backupStorageConfig(get: (name: string) => string | undefined): BackupStorage | null {
  const endpoint = (get('BACKUPS_S3_PUBLIC_ENDPOINT') || get('BACKUPS_S3_ENDPOINT'))?.replace(/\/+$/, '')
  const bucket = get('BACKUPS_S3_BUCKET')
  const accessKeyId = get('BACKUPS_S3_ACCESS_KEY_ID')
  const secretAccessKey = get('BACKUPS_S3_SECRET_ACCESS_KEY')
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  if (!/^https?:\/\//.test(endpoint) || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)) return null
  return { creds: { accessKeyId, secretAccessKey, region: get('BACKUPS_S3_REGION') || 'auto' }, bucket, publicEndpoint: endpoint }
}

// daily/ weekly/ monthly/ + the file name backup.sh writes — nothing else is ever signed.
const KEY = /^(?:daily|weekly|monthly)\/reqon-backup-\d{8}T\d{6}Z\.tar\.age$/

export function isBackupKey(key: unknown): key is string {
  return typeof key === 'string' && KEY.test(key)
}

export async function presignBackupGet(cfg: BackupStorage, key: string, now?: Date): Promise<string> {
  if (!isBackupKey(key)) throw new Error('not a backup object key')
  const name = key.slice(key.lastIndexOf('/') + 1)
  return presignUrl(cfg.creds, {
    method: 'GET',
    url: `${cfg.publicEndpoint}/${cfg.bucket}/${uriEncode(key, true)}`,
    expiresIn: BACKUP_URL_TTL,
    query: { 'response-content-disposition': `attachment; filename="${name}"` },
    now,
  })
}

// ---------------------------------------------------------------- the status record
export type BackupRecord = {
  destination: 'r2' | 'github' | 'drive'
  ok: boolean
  takenAt: string
  objectKey: string | null
  sizeBytes: number | null
  sha256: string | null
  migrationVersion: string | null
  dbSizeBytes: number | null
  rowCount: number | null
  recipients: string[]
  detail: string | null
}

const nullableInt = (v: unknown, min: number): number | null | undefined =>
  v === undefined || v === null ? null : typeof v === 'number' && Number.isSafeInteger(v) && v >= min ? v : undefined

// Shape checks only; the table's own CHECK constraints are the rules (a failure there is a 400 too).
export function parseBackupRecord(raw: unknown, now: Date = new Date()): BackupRecord | string {
  if (typeof raw !== 'object' || raw === null) return 'Send a JSON body.'
  const b = raw as Record<string, unknown>
  if (b.destination !== 'r2' && b.destination !== 'github' && b.destination !== 'drive') return 'destination must be r2, github or drive.'
  if (typeof b.ok !== 'boolean') return 'ok must be true or false.'
  const taken = typeof b.taken_at === 'string' ? Date.parse(b.taken_at) : NaN
  if (!Number.isFinite(taken) || taken > now.getTime() + 24 * 3600 * 1000 || taken < Date.UTC(2026, 0, 1)) return 'taken_at is not a plausible time.'
  const objectKey = b.object_key ?? null
  if (objectKey !== null && !isBackupKey(objectKey)) return 'object_key is not a backup object key.'
  const size = nullableInt(b.size_bytes, 1)
  const dbSize = nullableInt(b.db_size_bytes, 0)
  const rows = nullableInt(b.row_count, 0)
  if (size === undefined || dbSize === undefined || rows === undefined) return 'sizes and counts must be whole numbers.'
  const sha = b.sha256 ?? null
  if (sha !== null && !(typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha))) return 'sha256 must be 64 lowercase hex characters.'
  const migration = b.migration_version ?? null
  if (migration !== null && !(typeof migration === 'string' && /^\d{14}$/.test(migration))) return 'migration_version must be a 14-digit version.'
  const recipients = b.recipients ?? []
  if (!Array.isArray(recipients) || recipients.length > 20 || !recipients.every((r) => typeof r === 'string' && /^[0-9a-f]{16}$/.test(r))) {
    return 'recipients must list up to 20 key fingerprints.'
  }
  const detail = b.detail ?? null
  if (detail !== null && !(typeof detail === 'string' && detail.length <= 200 && !/[\u0000-\u001f]/.test(detail))) return 'detail must be a short text.'
  return {
    destination: b.destination,
    ok: b.ok,
    takenAt: new Date(taken).toISOString(),
    objectKey,
    sizeBytes: size,
    sha256: sha,
    migrationVersion: migration,
    dbSizeBytes: dbSize,
    rowCount: rows,
    recipients: recipients as string[],
    detail: detail === '' ? null : detail,
  }
}
