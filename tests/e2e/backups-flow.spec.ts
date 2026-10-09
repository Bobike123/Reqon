import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { expect, test } from '@playwright/test'
import { readManifest, runSql } from './setup/db.ts'
import { login } from './setup/login.ts'

// Settings → Backups (docs/ultraplan Phase 4) in a real browser against the local stack: the Board sees what
// the backup workflow recorded and can download the newest encrypted file through a signed link; a
// Treasurer and a plain member see no such section. The runs are fixtures written with SQL (the workflow
// itself is proven by `npm run backup:test:local`); the file in the bucket is a stand-in for ciphertext.
//
// Needs the attachment/backup Edge Functions served:
//   node scripts/attachments/functions-env-local.mjs
//   npx supabase functions serve --env-file supabase/functions/.env.local
const BUCKET = 'backups-local'
const KEY = 'daily/reqon-backup-20261008T031700Z.tar.age'
const MARK = 'e'.repeat(64) // sha256 value that marks the fixture rows
const BYTES = Buffer.from('age-encryption.org/v1\n-> fixture ciphertext, not a real backup\n'.repeat(40))

function statusEnv() {
  const out = execSync('npx supabase status -o env', { encoding: 'utf8' })
  const get = (name: string) => out.match(new RegExp(`${name}="?([^"\\n]+)"?`))?.[1] ?? ''
  return { url: get('API_URL'), serviceKey: get('SERVICE_ROLE_KEY') }
}
const admin = () => {
  const { url, serviceKey } = statusEnv()
  return createClient(url, serviceKey, { auth: { persistSession: false } })
}

test.beforeAll(async ({ request }) => {
  const res = await request.fetch('http://127.0.0.1:54321/functions/v1/backup-download-url', { method: 'OPTIONS' })
  expect(res.status(), 'The backup Edge Functions are not served. Run: node scripts/attachments/functions-env-local.mjs && npx supabase functions serve --env-file supabase/functions/.env.local').toBe(200)
  const storage = admin().storage
  await storage.createBucket(BUCKET, { public: false }) // already there on a stack started from config.toml
  const { error } = await storage.from(BUCKET).upload(KEY, BYTES, { contentType: 'application/octet-stream', upsert: true })
  expect(error).toBeNull()
})

test.afterAll(async () => {
  runSql(`delete from backup_runs where sha256 = '${MARK}' or detail = 'e2e-fixture'`)
  await admin().storage.from(BUCKET).remove([KEY])
})

test.beforeEach(() => {
  runSql(`delete from backup_runs where sha256 = '${MARK}' or detail = 'e2e-fixture'`)
  runSql(
    `insert into backup_runs (destination, taken_at, ok, object_key, size_bytes, sha256, migration_version, db_size_bytes, row_count, recipients) values
       ('r2', now() - interval '5 hours', true, '${KEY}', ${BYTES.length}, '${MARK}', '20260133000000', 25000000, 4010, array['331b42d7939c739e','6a2e7461c39ab98e']),
       ('github', now() - interval '2 days', true, null, ${BYTES.length}, '${MARK}', '20260133000000', 25000000, 4010, array['331b42d7939c739e']),
       ('drive', now() - interval '1 hour', false, null, null, null, null, null, null, '{}')`,
  )
  runSql(`update backup_runs set detail = 'e2e-fixture' where destination = 'drive' and not ok and detail is null`)
})

test.describe('Settings → Backups', () => {
  test('the Vice President sees the destinations, a failure in words, and downloads the newest file', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.vicepresident.email, m.password)
    await page.goto('/settings')
    const panel = page.getByTestId('backups-panel')
    await expect(panel).toBeVisible()

    await expect(panel.getByTestId('backup-r2')).toContainText('Last backup 5 hours ago.')
    await expect(panel.getByTestId('backup-sha-r2')).toHaveText(MARK)
    await expect(panel.getByTestId('backup-r2')).toContainText('2 keys')
    await expect(panel.getByTestId('backup-github')).toContainText('Last backup 2 days ago.')
    // The drive attempt failed (detail is not one of the known codes → shown as a code, not hidden).
    await expect(panel.getByTestId('backup-drive')).toContainText('Failed')
    // The daily copy is fine, so the headline names the weekly copy that needs attention.
    await expect(panel.getByTestId('backups-overall')).toContainText('Google Drive (weekly)')

    const [download] = await Promise.all([page.waitForEvent('download'), panel.getByTestId('backup-download').click()])
    expect(download.suggestedFilename()).toBe('reqon-backup-20261008T031700Z.tar.age')
    expect(readFileSync((await download.path())!).equals(BYTES)).toBe(true)
    await expect(panel.getByTestId('backup-saved')).toContainText(MARK.slice(0, 16))
  })

  test('a Developer sees it too', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.developer.email, m.password)
    await page.goto('/settings')
    await expect(page.getByTestId('backups-panel')).toBeVisible()
  })

  test('the Treasurer and a plain member see no Backups section', async ({ page }) => {
    const m = readManifest()
    for (const who of [m.users.treasurer, m.users.member]) {
      await login(page, who.email, m.password)
      await page.goto('/settings')
      await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Backups', exact: true })).toHaveCount(0)
      await expect(page.getByTestId('backups-panel')).toHaveCount(0)
    }
  })

  test('the database also refuses them: no rows for a Treasurer, and no download link', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.treasurer.email, m.password)
    const token = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.endsWith('-auth-token'))
      return key ? (JSON.parse(localStorage.getItem(key)!) as { access_token: string }).access_token : ''
    })
    expect(token).not.toBe('')
    const res = await page.request.post('http://127.0.0.1:54321/functions/v1/backup-download-url', {
      headers: { Authorization: `Bearer ${token}`, apikey: process.env.VITE_SUPABASE_ANON_KEY ?? '' },
      data: {},
    })
    expect(res.status()).toBe(404)
    expect(JSON.stringify(await res.json())).not.toContain('X-Amz')
  })
})
