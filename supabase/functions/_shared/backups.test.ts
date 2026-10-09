import { describe, expect, it } from 'vitest'
import { BACKUP_URL_TTL, backupStorageConfig, isBackupKey, parseBackupRecord, presignBackupGet } from './backups.ts'

const env = (o: Record<string, string>) => (n: string) => o[n]
const GOOD_ENV = {
  BACKUPS_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/',
  BACKUPS_S3_BUCKET: 'reqon-backups',
  BACKUPS_S3_ACCESS_KEY_ID: 'AKIATEST',
  BACKUPS_S3_SECRET_ACCESS_KEY: 'secret',
}
const KEY = 'daily/reqon-backup-20261008T031700Z.tar.age'
const SHA = 'a'.repeat(64)
const NOW = new Date('2026-10-08T12:00:00Z')
const GOOD = {
  destination: 'r2',
  ok: true,
  taken_at: '2026-10-08T03:17:00.000Z',
  object_key: KEY,
  size_bytes: 860666,
  sha256: SHA,
  migration_version: '20260133000000',
  db_size_bytes: 25234579,
  row_count: 4010,
  recipients: ['331b42d7939c739e'],
  detail: null,
}

describe('backup storage configuration', () => {
  it('reads the BACKUPS_S3_* settings, strips trailing slashes, defaults the region', () => {
    expect(backupStorageConfig(env(GOOD_ENV))).toEqual({
      creds: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret', region: 'auto' },
      bucket: 'reqon-backups',
      publicEndpoint: 'https://acct.r2.cloudflarestorage.com',
    })
  })
  it('prefers the public endpoint (locally the browser and the container see different hosts)', () => {
    expect(backupStorageConfig(env({ ...GOOD_ENV, BACKUPS_S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:54321/storage/v1/s3' }))?.publicEndpoint).toBe('http://127.0.0.1:54321/storage/v1/s3')
  })
  it.each([
    ['a missing key', { ...GOOD_ENV, BACKUPS_S3_ACCESS_KEY_ID: '' }],
    ['a missing bucket', { ...GOOD_ENV, BACKUPS_S3_BUCKET: '' }],
    ['a non-http endpoint', { ...GOOD_ENV, BACKUPS_S3_ENDPOINT: 'ftp://x' }],
    ['an invalid bucket name', { ...GOOD_ENV, BACKUPS_S3_BUCKET: '../x' }],
    ['the attachments settings only', { ATTACHMENTS_S3_ENDPOINT: 'https://x', ATTACHMENTS_S3_BUCKET: 'a-b', ATTACHMENTS_S3_ACCESS_KEY_ID: 'k', ATTACHMENTS_S3_SECRET_ACCESS_KEY: 's' }],
  ])('refuses %s', (_, e) => {
    expect(backupStorageConfig(env(e))).toBeNull()
  })
})

describe('backup object keys', () => {
  it.each([KEY, 'weekly/reqon-backup-20261004T031700Z.tar.age', 'monthly/reqon-backup-20261001T031700Z.tar.age'])('accepts %s', (k) => {
    expect(isBackupKey(k)).toBe(true)
  })
  it.each([
    'other/reqon-backup-20261008T031700Z.tar.age',
    'daily/../reqon-backup-20261008T031700Z.tar.age',
    'daily/reqon-backup-20261008T031700Z.tar',
    'daily/reqon-backup-20261008T031700Z.meta.json',
    'daily/x/reqon-backup-20261008T031700Z.tar.age',
    '/daily/reqon-backup-20261008T031700Z.tar.age',
    'tasks/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg',
    '',
    null,
    42,
  ])('refuses %s', (k) => {
    expect(isBackupKey(k)).toBe(false)
  })
})

describe('signed download link', () => {
  const cfg = backupStorageConfig(env(GOOD_ENV))!
  it('is a 10-minute GET for exactly that object, saved under the file name', async () => {
    const url = new URL(await presignBackupGet(cfg, KEY, new Date('2026-10-08T12:00:00Z')))
    expect(url.pathname).toBe(`/reqon-backups/${KEY}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(BACKUP_URL_TTL))
    expect(BACKUP_URL_TTL).toBe(600)
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="reqon-backup-20261008T031700Z.tar.age"')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })
  it('refuses to sign anything that is not a backup key', async () => {
    await expect(presignBackupGet(cfg, 'tasks/x.jpg')).rejects.toThrow('not a backup object key')
  })
})

describe('backup record parsing', () => {
  it('accepts a full ok record and normalises the time', () => {
    expect(parseBackupRecord(GOOD, NOW)).toEqual({
      destination: 'r2', ok: true, takenAt: '2026-10-08T03:17:00.000Z', objectKey: KEY, sizeBytes: 860666, sha256: SHA,
      migrationVersion: '20260133000000', dbSizeBytes: 25234579, rowCount: 4010, recipients: ['331b42d7939c739e'], detail: null,
    })
  })
  it('accepts a failure record with only a code', () => {
    expect(parseBackupRecord({ destination: 'github', ok: false, taken_at: '2026-10-08T03:17:00Z', detail: 'upload_failed' }, NOW)).toMatchObject({
      ok: false, objectKey: null, sizeBytes: null, sha256: null, recipients: [], detail: 'upload_failed',
    })
  })
  it.each([
    [null, 'Send a JSON body.'],
    [{ ...GOOD, destination: 'ftp' }, 'destination must be'],
    [{ ...GOOD, ok: 'yes' }, 'ok must be'],
    [{ ...GOOD, taken_at: 'yesterday' }, 'taken_at'],
    [{ ...GOOD, taken_at: '2026-10-20T00:00:00Z' }, 'taken_at'],
    [{ ...GOOD, taken_at: '2001-01-01T00:00:00Z' }, 'taken_at'],
    [{ ...GOOD, object_key: 'daily/../x.tar.age' }, 'object_key'],
    [{ ...GOOD, size_bytes: 0 }, 'whole numbers'],
    [{ ...GOOD, size_bytes: 1.5 }, 'whole numbers'],
    [{ ...GOOD, row_count: -1 }, 'whole numbers'],
    [{ ...GOOD, sha256: 'A'.repeat(64) }, 'sha256'],
    [{ ...GOOD, migration_version: '2026' }, 'migration_version'],
    [{ ...GOOD, recipients: ['short'] }, 'recipients'],
    [{ ...GOOD, recipients: Array(21).fill('331b42d7939c739e') }, 'recipients'],
    [{ ...GOOD, detail: 'x'.repeat(201) }, 'detail'],
    [{ ...GOOD, detail: 'line\nbreak' }, 'detail'],
  ])('refuses %j', (body, message) => {
    expect(parseBackupRecord(body, NOW)).toEqual(expect.stringContaining(message))
  })
})
