import { test, expect } from '@playwright/test'
import { readManifest, runSql } from './setup/db.ts'
import { login } from './setup/login.ts'

// Phase 14: the Gantt's pointer drag and its keyboard alternatives, in a real
// browser against the real database. One fixture task (tagged, removed after)
// owned by the member, on the season's first submission with no section. It is
// driven by the Head of the task's department: since the gantt-fix change a plain
// member only views the Gantt (no drag handles, no Move to), even for own tasks.
//   * dragging the bar moves both dates and saves through the ordinary task
//     update — nothing is written while dragging;
//   * the task's own date fields do the same by keyboard;
//   * dragging the row onto a section of the same submission moves it there.
const PREFIX = '[E2E Phase14 gantt]'
const TITLE = `${PREFIX} drag me`
const iso = (d: Date) => d.toISOString().slice(0, 10)
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

let taskId = ''
test.beforeEach(() => {
  const m = readManifest()
  const start = new Date()
  start.setUTCDate(start.getUTCDate() + 10)
  const due = new Date(start)
  due.setUTCDate(due.getUTCDate() + 8)
  taskId = runSql(
    `insert into tasks (season_id, title, state, owner_id, subteam_key, milestone_key, starts_on, due_date)
     values ('${m.season.id}', '${TITLE}', 'todo', '${m.users.member.id}', '${m.departments.headA.key}', '${m.milestoneKey}', '${iso(start)}', '${iso(due)}')
     returning id`,
  ).trim().split('\n')[0]
})
test.afterEach(() => {
  runSql(`delete from activity where entity = 'task' and entity_id in (select id::text from tasks where title like '${PREFIX}%')`)
  runSql(`delete from tasks where title like '${PREFIX}%'`)
})

const datesOf = (id: string) => runSql(`select starts_on, due_date, section_id from tasks where id = '${id}'`).trim().split('|')

test.describe('Gantt schedule and move (UI-06)', () => {
  test('dragging the bar moves both dates once, on release; the date fields do the same by keyboard', async ({ page }) => {
    const m = readManifest()
    const [start0, due0] = datesOf(taskId)
    await login(page, m.users.headA.email, m.password)
    await page.goto(`/gantt?open=${encodeURIComponent(m.milestoneKey)}&scale=month`)
    const group = page.getByTestId(`gantt-unsectioned-${m.milestoneKey}`)
    const toggle = group.getByRole('button', { name: /Unsectioned work/ })
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    const row = page.getByTestId(`gantt-task-${taskId}`)
    await expect(row).toBeVisible()

    // ---- Pointer drag of the bar body ----
    // A pointer affordance for wide screens. On a phone the sticky label column
    // fills the width and the track scrolls under it, so the task's own date
    // fields below are the way (the same change, by touch or keyboard).
    let start1 = start0
    let due1 = due0
    if ((page.viewportSize()?.width ?? 1280) >= 768) {
      const body = row.locator('[data-schedule-part="move"]')
      await body.scrollIntoViewIfNeeded()
      const box = (await body.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 8 })
      // Nothing is written while dragging.
      expect(datesOf(taskId).slice(0, 2)).toEqual([start0, due0])
      await page.mouse.up()
      await expect.poll(() => datesOf(taskId)[0], { timeout: 10_000 }).not.toBe(start0)
      ;[start1, due1] = datesOf(taskId)
      // Both moved by the same number of days: the length of the work is kept.
      expect(days(start0, start1)).toBeGreaterThan(0)
      expect(days(start0, start1)).toBe(days(due0, due1))
    }

    // ---- The keyboard alternative: the task's own fields ----
    await row.getByRole('button', { name: /Show details of/ }).click()
    const panel = page.getByTestId(`gantt-task-more-${taskId}`)
    const newDue = iso(new Date(Date.parse(due1) + 3 * 86_400_000))
    await panel.getByLabel('Deadline').fill(newDue)
    await panel.getByLabel('Deadline').press('Enter')
    await expect(page.getByTestId(`gantt-date-result-${taskId}`)).toContainText('Saved: deadline.')
    await expect.poll(() => datesOf(taskId)[1]).toBe(newDue)

    // A start after the deadline is refused before anything is sent.
    await panel.getByLabel('Start date').fill(iso(new Date(Date.parse(newDue) + 86_400_000)))
    await panel.getByRole('button', { name: 'Save dates' }).click()
    await expect(page.getByTestId(`gantt-date-result-${taskId}`)).toContainText('The start date must be on or before the deadline.')
    expect(datesOf(taskId)[1]).toBe(newDue)

    // A refresh shows what was saved.
    await page.reload()
    await expect(page.getByTestId(`gantt-task-more-${taskId}`).getByLabel('Deadline')).toHaveValue(newDue)
  })

  test('dragging the row onto a section of the same submission moves it there, as "Move to" does', async ({ page }) => {
    const m = readManifest()
    const [sectionId, sectionName] = runSql(`select id, name from milestone_sections where milestone_key = '${m.milestoneKey}' order by ordinal limit 1`).trim().split('|')
    await login(page, m.users.headA.email, m.password)
    await page.goto(`/gantt?open=${encodeURIComponent(m.milestoneKey)}`)
    const group = page.getByTestId(`gantt-unsectioned-${m.milestoneKey}`)
    const toggle = group.getByRole('button', { name: /Unsectioned work/ })
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    const row = page.getByTestId(`gantt-task-${taskId}`)
    await expect(row).toBeVisible()
    const source = row.locator('[draggable="true"]').first()
    const target = page.getByTestId(`gantt-section-${sectionId}`).locator('[data-drop-target="true"]')
    await source.dragTo(target)
    await expect.poll(() => datesOf(taskId)[2], { timeout: 10_000 }).toBe(sectionId)
    await expect(page.getByTestId(`gantt-section-${sectionId}`)).toContainText(sectionName)
  })
})
