import { execSync } from 'node:child_process'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { expect, test, type Page } from '@playwright/test'
import { readManifest, runSql } from './setup/db.ts'
import { login } from './setup/login.ts'

// Task attachments (docs/ultraplan Phase 3) in a real browser against the local stack: the real
// compression worker (canvas + WebCodecs/Mediabunny), the real Edge Functions and real bytes through the
// stack's S3 endpoint — the code path that talks to Cloudflare R2 in production.
//
// Needs, besides the usual local stack:
//   npx supabase functions serve --env-file supabase/functions/.env.local
// The dev server is started with VITE_ATTACHMENTS_ENABLED=true by playwright.config.ts.
const PREFIX = '[E2E attachments]'
const FIXTURES = path.join(import.meta.dirname, 'fixtures')
const BUCKET = 'attachments-local'
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

let taskId = ''

function statusEnv() {
  const out = execSync('npx supabase status -o env', { encoding: 'utf8' })
  const get = (name: string) => out.match(new RegExp(`${name}="?([^"\\n]+)"?`))?.[1] ?? ''
  return { url: get('API_URL'), serviceKey: get('SERVICE_ROLE_KEY') }
}

async function removeObjects(keys: string[]) {
  if (keys.length === 0) return
  const { url, serviceKey } = statusEnv()
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  await admin.storage.from(BUCKET).remove(keys)
}

test.beforeAll(async ({ request }) => {
  const res = await request.fetch('http://127.0.0.1:54321/functions/v1/attachment-upload-url', { method: 'OPTIONS' })
  expect(res.status(), 'Attachment Edge Functions are not served. Run: npx supabase functions serve --env-file supabase/functions/.env.local').toBe(200)
})

test.beforeEach(() => {
  const m = readManifest()
  taskId = runSql(
    `insert into tasks (season_id, title, state, owner_id, subteam_key, milestone_key)
     values ('${m.season.id}', '${PREFIX} car photos', 'todo', '${m.users.member.id}', '${m.departments.headA.key}', '${m.milestoneKey}')
     returning id`,
  ).trim().split('\n')[0]
})

test.afterEach(async () => {
  const keys = runSql(
    `select object_key || coalesce(',' || thumb_key, '') from task_attachments where task_id in (select id from tasks where title like '${PREFIX}%')`,
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => line.split(','))
  await removeObjects(keys)
  runSql(`delete from attachment_purge_queue where task_id in (select id from tasks where title like '${PREFIX}%')`)
  runSql(`delete from activity where entity = 'task' and entity_id in (select id::text from tasks where title like '${PREFIX}%')`)
  // task_attachments cascade with the task; the cascade trigger queues their keys — removed again here.
  runSql(`delete from tasks where title like '${PREFIX}%'`)
  runSql(`delete from attachment_purge_queue where task_id = '${taskId}'`)
})

async function openFiles(page: Page) {
  await page.goto(`/board?task=${taskId}`)
  const card = page.getByTestId(`task-${taskId}`)
  await expect(card).toBeVisible()
  const details = card.getByTestId(`task-more-${taskId}`)
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.locator('summary').click()
  const files = page.getByTestId(`task-files-${taskId}`)
  await expect(files).toBeVisible()
  return files
}

const rowOf = (name: string) =>
  runSql(
    `select status || '|' || mime_type || '|' || coalesce(width::text, '') || '|' || coalesce(height::text, '') || '|' || playable || '|' || coalesce(duration_ms::text, '')
       from task_attachments where task_id = '${taskId}' and original_name = '${name}'`,
  ).trim()

test.describe('task attachments', () => {
  test('the owner adds a photo: compressed to 2048 px WebP with a thumbnail, shown as a tile and full size', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    const files = await openFiles(page)
    await expect(files.getByText('No files yet.')).toBeVisible()

    await files.getByTestId(`task-files-input-${taskId}`).setInputFiles(path.join(FIXTURES, 'photo-3000x2000.jpg'))
    const tile = files.getByRole('button', { name: 'Open photo: photo-3000x2000.webp' })
    await expect(tile).toBeVisible({ timeout: 30_000 })
    expect(rowOf('photo-3000x2000.webp')).toBe('ready|image/webp|2048|1366|true|')
    // The tile shows the thumbnail, loaded from the bucket through a signed URL.
    await expect.poll(() => tile.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(400)

    await tile.click()
    const box = page.getByTestId('attachment-lightbox')
    await expect.poll(() => box.getByTestId('lightbox-photo').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(2048)
    await box.getByTestId('lightbox-close').click()
    await expect(box).toBeHidden()
  })

  test('the owner adds a 1080p video: compressed in the browser to a playable 720p MP4 with a poster', async ({ page }) => {
    test.setTimeout(90_000)
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    const files = await openFiles(page)
    await files.getByTestId(`task-files-input-${taskId}`).setInputFiles(path.join(FIXTURES, 'clip-1080p.webm'))
    await expect(page.getByRole('progressbar', { name: /Compressing clip-1080p.webm/ }).or(files.getByRole('button', { name: /Open video/ })).first()).toBeVisible()
    const tile = files.getByRole('button', { name: /Open video.*: clip-1080p/ })
    await expect(tile).toBeVisible({ timeout: 60_000 })

    const [status, mime, width, height, playable, duration] = rowOf((await tile.getAttribute('aria-label'))!.split(': ')[1]).split('|')
    expect({ status, mime, width, height, playable }).toEqual({ status: 'ready', mime: 'video/mp4', width: '1280', height: '720', playable: 'true' })
    expect(Number(duration)).toBeGreaterThan(2500)
    expect(Number(duration)).toBeLessThan(3500)
    await expect(tile).toContainText('0:03')

    await tile.click()
    const player = page.getByTestId('video-player')
    await expect(player).toHaveAttribute('src', /attachments-local/)
    expect(await page.locator('video').count()).toBe(1)
    // Range seeking against the bucket: the browser reads the duration from the fast-start MP4 header.
    await expect.poll(() => player.evaluate((v) => (v as HTMLVideoElement).duration), { timeout: 15_000 }).toBeGreaterThan(2.5)
  })

  test('a PDF is added and deleted by its uploader; another member cannot delete it', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    let files = await openFiles(page)
    await files.getByTestId(`task-files-input-${taskId}`).setInputFiles({ name: 'quote.pdf', mimeType: 'application/pdf', buffer: PDF })
    await expect(files.getByRole('button', { name: 'Open PDF: quote.pdf' })).toBeVisible({ timeout: 30_000 })
    expect(rowOf('quote.pdf').split('|')[0]).toBe('ready')

    // Head B leads another department: may see the file, may neither add files here nor delete it.
    await login(page, m.users.headB.email, m.password)
    files = await openFiles(page)
    await expect(files.getByRole('button', { name: /Add photos/ })).toHaveCount(0)
    await files.getByRole('button', { name: 'Open PDF: quote.pdf' }).click()
    const box = page.getByTestId('attachment-lightbox')
    await expect(box.getByTestId('lightbox-download')).toBeVisible()
    await expect(box.getByTestId('lightbox-delete')).toHaveCount(0)
    await box.getByTestId('lightbox-close').click()

    await login(page, m.users.member.email, m.password)
    files = await openFiles(page)
    await files.getByRole('button', { name: 'Open PDF: quote.pdf' }).click()
    await page.getByTestId('lightbox-delete').click()
    await page.getByTestId('lightbox-delete-confirm').click()
    await expect(files.getByText('No files yet.')).toBeVisible()
    expect(rowOf('quote.pdf').split('|')[0]).toBe('deleted')
    expect(runSql(`select count(*) from attachment_purge_queue where task_id = '${taskId}' and reason = 'deleted'`).trim()).toBe('1')
  })
})
