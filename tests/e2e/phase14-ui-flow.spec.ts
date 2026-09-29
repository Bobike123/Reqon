import { test, expect } from '@playwright/test'
import { readManifest, runSql } from './setup/db.ts'
import { login } from './setup/login.ts'

// Phase 14 UI in a real browser, against the real local database: what is
// saved is read back from Postgres, and a reload shows it. Every row created
// here carries PREFIX and is removed afterwards (with its audit rows).
const PREFIX = '[E2E Phase14 ui]'
const iso = (d: Date) => d.toISOString().slice(0, 10)

let taskId = ''
let meetingId = ''
test.beforeEach(() => {
  const m = readManifest()
  const due = new Date()
  due.setUTCDate(due.getUTCDate() + 20)
  taskId = runSql(
    `insert into tasks (season_id, title, state, owner_id, subteam_key, due_date)
     values ('${m.season.id}', '${PREFIX} owned task', 'todo', '${m.users.member.id}', '${m.departments.headA.key}', '${iso(due)}') returning id`,
  ).trim().split('\n')[0]
  meetingId = runSql(
    `insert into meetings (season_id, title, held_on, agenda)
     values ('${m.season.id}', '${PREFIX} build meeting', current_date,
             E'## Build status\\n\\nWhere we are.\\n\\n- Frame\\n  - welds checked\\n- Fairing <img src=x onerror=alert(1)>')
     returning id`,
  ).trim().split('\n')[0]
})
test.afterEach(() => {
  runSql(`delete from task_requirements where task_id in (select id from tasks where title like '${PREFIX}%')`)
  runSql(`delete from activity where entity = 'task' and entity_id in (select id::text from tasks where title like '${PREFIX}%')`)
  runSql(`delete from tasks where title like '${PREFIX}%'`)
  runSql(`delete from meetings where title like '${PREFIX}%'`)
})

test.describe('Phase 14 UI against the real database', () => {
  test('Meetings: stored Markdown reads as headings and nested lists, never raw HTML; the default agenda is edited only in its dialog', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    await page.goto('/meetings')
    const agenda = page.getByTestId(`meeting-agenda-${meetingId}`)
    await expect(agenda.getByRole('heading', { name: 'Build status' })).toBeVisible()
    await expect(agenda.locator('li li')).toHaveText('welds checked')
    await expect(agenda.locator('img')).toHaveCount(0)
    // A member neither calls meetings nor edits the default agenda.
    await expect(page.getByRole('button', { name: 'Edit default agenda' })).toHaveCount(0)

    const before = runSql(`select md5(body) from meeting_template`).trim()
    await login(page, m.users.developer.email, m.password)
    await page.goto('/meetings')
    await expect(page.getByLabel('Default agenda', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Edit default agenda' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Default agenda', { exact: true }).fill('## Safety\n\n- helmets\n  - checked')
    await dialog.getByRole('button', { name: 'Preview' }).click()
    await expect(dialog.getByRole('heading', { name: 'Safety' })).toBeVisible()
    // Escape closes it; the typed text is kept, and nothing was saved.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('template-draft-kept')).toBeVisible()
    await page.getByRole('button', { name: 'Edit default agenda' }).click()
    await expect(page.getByRole('dialog').getByLabel('Default agenda', { exact: true })).toHaveValue('## Safety\n\n- helmets\n  - checked')
    await page.getByRole('dialog').getByRole('button', { name: 'Discard changes' }).click()
    expect(runSql(`select md5(body) from meeting_template`).trim()).toBe(before)
  })

  test('Spec Sheet: the compact table, the Competition column says it has no data, and a row opens into its editor', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    await page.goto('/specs')
    const table = page.getByRole('table', { name: 'Specifications' })
    await expect(table.getByRole('columnheader')).toHaveText(['Parameter / unit', 'Current (ours)', 'Ideal', 'Regulatory limit', 'Competition'])
    const row = page.getByTestId(`spec-${m.spec.id}`)
    await expect(row.getByTestId(`competition-${m.spec.id}`)).toContainText('No competition data')
    await expect(row.getByLabel(/^New measurement/)).toHaveCount(0)
    await row.getByTestId(`spec-toggle-${m.spec.id}`).click()
    await expect(row.getByLabel(/^New measurement/)).toBeVisible()
    await page.reload()
    await expect(page.getByTestId(`spec-${m.spec.id}`).getByLabel(/^New measurement/)).toBeVisible()
  })

  test('Register: link an existing task to a rule and unlink it, saved in the database and shown after a reload', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    await page.goto(`/register?search=${encodeURIComponent(m.clauseKey)}`)
    await page.getByTestId(`assign-open-${m.clauseKey}`).click()
    const panel = page.getByTestId(`assign-tasks-${m.clauseKey}`)
    await panel.getByLabel(/Find a task/).fill(PREFIX)
    await panel.getByTestId(`assign-row-${taskId}`).getByRole('button', { name: /^Link/ }).click()
    await expect(panel.getByText(/is now linked to/)).toBeVisible()
    expect(runSql(`select count(*) from task_requirements where task_id = '${taskId}' and clause_key = '${m.clauseKey}'`).trim()).toBe('1')

    await page.reload()
    await page.getByTestId(`assign-open-${m.clauseKey}`).click()
    const again = page.getByTestId(`assign-tasks-${m.clauseKey}`)
    await again.getByLabel(/Find a task/).fill(PREFIX)
    await expect(again.getByTestId(`assign-row-${taskId}`)).toContainText('linked')
    await again.getByTestId(`assign-row-${taskId}`).getByRole('button', { name: /^Unlink/ }).click()
    await expect(again.getByText(/is no longer linked to/)).toBeVisible()
    expect(runSql(`select count(*) from task_requirements where task_id = '${taskId}'`).trim()).toBe('0')
  })

  test('Board: clearing a deadline really clears it, and a reload shows it cleared', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    await page.goto(`/board?task=${taskId}`)
    const details = page.getByTestId(`task-details-${taskId}`)
    await expect(details).toBeVisible()
    await details.getByLabel('Deadline').fill('')
    await details.getByTestId(`task-save-${taskId}`).click()
    await expect(details.getByTestId(`task-save-result-${taskId}`)).toContainText('Saved: deadline removed')
    expect(runSql(`select due_date is null from tasks where id = '${taskId}'`).trim()).toBe('t')
    await page.reload()
    await expect(page.getByTestId(`task-details-${taskId}`).getByLabel('Deadline')).toHaveValue('')
  })

  test('Settings: a member gets no department editor; a Developer opens the exact one from a link, and Cancel changes nothing', async ({ page }) => {
    const m = readManifest()
    const key = m.departments.headA.key
    await login(page, m.users.member.email, m.password)
    await page.goto(`/settings?edit=department:${key}`)
    await expect(page.getByTestId(`department-row-${key}`)).toHaveCount(0)

    const before = runSql(`select name, lead_id, is_parked, coalesce(description, '') from subteams where key = '${key}'`).trim()
    await login(page, m.users.developer.email, m.password)
    await page.goto(`/settings?edit=department:${key}`)
    const editor = page.getByTestId(`department-editor-${key}`)
    await expect(editor.getByLabel(`Name for ${key}`)).toBeFocused()
    await editor.getByLabel(`Name for ${key}`).fill('Something else entirely')
    await editor.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId(`department-editor-${key}`)).toHaveCount(0)
    expect(runSql(`select name, lead_id, is_parked, coalesce(description, '') from subteams where key = '${key}'`).trim()).toBe(before)
  })
})
