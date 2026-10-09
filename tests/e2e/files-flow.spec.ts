import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { expect, test } from '@playwright/test'
import { readManifest, runSql } from './setup/db.ts'
import { login } from './setup/login.ts'

// The Files page (SMC import): every file of the season in one grid, with a preview image for a PDF.
// Rows and bytes are seeded straight into the local stack (a preview for a PDF cannot come from the in-app
// upload path), through the same bucket and Edge Functions the app uses.
//   npx supabase functions serve --env-file supabase/functions/.env.local   (node scripts/attachments/functions-env-local.mjs first)
const PREFIX = '[E2E files]'
const BUCKET = 'attachments-local'
const JPG = readFileSync(path.join(import.meta.dirname, 'fixtures', 'photo-3000x2000.jpg'))
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

let taskId = ''
const ids = { photo: '', pdf: '' }

function statusEnv() {
  const out = execSync('npx supabase status -o env', { encoding: 'utf8' })
  const get = (name: string) => out.match(new RegExp(`${name}="?([^"\\n]+)"?`))?.[1] ?? ''
  return { url: get('API_URL'), serviceKey: get('SERVICE_ROLE_KEY') }
}

test.beforeEach(async ({ request }) => {
  const res = await request.fetch('http://127.0.0.1:54321/functions/v1/attachment-download-url', { method: 'OPTIONS' })
  expect(res.status(), 'Attachment Edge Functions are not served. Run: npx supabase functions serve --env-file supabase/functions/.env.local').toBe(200)
  const m = readManifest()
  taskId = runSql(
    `insert into tasks (season_id, title, state, owner_id) values ('${m.season.id}', '${PREFIX} logo and bylaws', 'todo', '${m.users.member.id}') returning id`,
  ).trim().split('\n')[0]
  ids.photo = crypto.randomUUID()
  ids.pdf = crypto.randomUUID()
  const { url, serviceKey } = statusEnv()
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const put = async (key: string, body: Buffer, type: string) => {
    const { error } = await admin.storage.from(BUCKET).upload(key, body, { contentType: type, upsert: true })
    expect(error).toBeNull()
  }
  const key = (id: string, ext: string) => `tasks/${taskId}/${id}.${ext}`
  await put(key(ids.photo, 'webp'), JPG, 'image/webp')
  await put(key(ids.photo, 'thumb.webp'), JPG, 'image/webp')
  await put(key(ids.pdf, 'pdf'), PDF, 'application/pdf')
  await put(key(ids.pdf, 'thumb.webp'), JPG, 'image/webp')
  runSql(
    `insert into task_attachments (id, task_id, kind, object_key, thumb_key, original_name, mime_type, size_bytes, width, height, status)
     values ('${ids.photo}', '${taskId}', 'photo', '${key(ids.photo, 'webp')}', '${key(ids.photo, 'thumb.webp')}', 'club-logo.webp', 'image/webp', 4000, 2048, 1366, 'ready'),
            ('${ids.pdf}', '${taskId}', 'document', '${key(ids.pdf, 'pdf')}', '${key(ids.pdf, 'thumb.webp')}', 'bylaws-v3.pdf', 'application/pdf', ${PDF.length}, null, null, 'ready')`,
  )
})

test.afterEach(async () => {
  const keys = runSql(
    `select object_key || ',' || thumb_key from task_attachments where task_id in (select id from tasks where title like '${PREFIX}%')`,
  ).trim().split('\n').filter(Boolean).flatMap((l) => l.split(','))
  const { url, serviceKey } = statusEnv()
  if (keys.length) await createClient(url, serviceKey, { auth: { persistSession: false } }).storage.from(BUCKET).remove(keys)
  runSql(`delete from attachment_purge_queue where task_id in (select id from tasks where title like '${PREFIX}%')`)
  runSql(`delete from activity where entity = 'task' and entity_id in (select id::text from tasks where title like '${PREFIX}%')`)
  runSql(`delete from tasks where title like '${PREFIX}%'`)
  runSql(`delete from attachment_purge_queue where task_id = '${taskId}'`)
})

test.describe('Files page', () => {
  test('lists the photo and the PDF with a preview image each, filters, searches and opens a file', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    await page.goto('/files')
    await expect(page.getByRole('heading', { name: 'Files', level: 1 })).toBeVisible()

    const photo = page.getByTestId(`file-card-${ids.photo}`)
    const pdf = page.getByTestId(`file-card-${ids.pdf}`)
    await expect(photo).toBeVisible()
    await expect(pdf).toBeVisible()
    // Both tiles show a picture loaded from the bucket through a signed link — the PDF too.
    await expect.poll(() => photo.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect.poll(() => pdf.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect(pdf).toContainText('PDF')
    await expect(photo.getByRole('link', { name: `${PREFIX} logo and bylaws` })).toHaveAttribute('href', `/board?task=${taskId}`)

    await page.getByRole('button', { name: /^PDFs/ }).click()
    await expect(photo).toBeHidden()
    await expect(pdf).toBeVisible()
    await page.getByRole('button', { name: /^All/ }).click()
    await page.getByTestId('files-search').fill('club-logo')
    await expect(pdf).toBeHidden()
    await expect(photo).toBeVisible()

    await photo.getByRole('button', { name: /Open photo: club-logo\.webp/ }).click()
    const box = page.getByTestId('attachment-lightbox')
    await expect(box).toBeVisible()
    // Viewing from here changes nothing: no delete control.
    await expect(box.getByRole('button', { name: /^Delete/ })).toHaveCount(0)
    await box.getByTestId('lightbox-close').click()
    await expect(box).toBeHidden()
  })

  test('the Files item is in the menu', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    const menu = page.getByRole('button', { name: 'Menu' })
    if (await menu.isVisible().catch(() => false)) await menu.click()
    await page.getByRole('link', { name: 'Files', exact: true }).first().click()
    await expect(page).toHaveURL(/\/files/)
  })
})
