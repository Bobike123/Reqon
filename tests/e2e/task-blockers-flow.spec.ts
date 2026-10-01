import { test, expect } from '@playwright/test'
import { readManifest, runSql } from './setup/db.ts'
import { login } from './setup/login.ts'

// Backend completion Phase 3 in a real browser against the real (local) database:
//   * blocking a task asks for a reason first and stores it with the state;
//   * a prerequisite in ANOTHER department is linked from the Board card, shown
//     on the Gantt, and survives a reload;
//   * the reverse link would close a circle and is never offered;
//   * a stale save is refused as "changed by someone else" and does not overwrite.
// Fixture tasks are tagged and removed after each test.
const PREFIX = '[E2E Phase3 blockers]'
const T1 = `${PREFIX} mine`
const T2 = `${PREFIX} other department`

let t1 = ''
let t2 = ''
test.beforeEach(() => {
  const m = readManifest()
  const insert = (title: string, owner: string, dept: string) =>
    runSql(
      `insert into tasks (season_id, title, state, owner_id, subteam_key, milestone_key, starts_on, due_date)
       values ('${m.season.id}', '${title}', 'todo', '${owner}', '${dept}', '${m.milestoneKey}', current_date + 5, current_date + 20)
       returning id`,
    ).trim().split('\n')[0]
  t1 = insert(T1, m.users.member.id, m.departments.headA.key)
  t2 = insert(T2, m.users.headB.id, m.departments.headB.key)
})
test.afterEach(() => {
  runSql(`delete from activity where entity = 'task' and entity_id in (select id::text from tasks where title like '${PREFIX}%')`)
  runSql(`delete from tasks where title like '${PREFIX}%'`) // task_dependencies cascade with them
})

test.describe('blockers and prerequisites (Phase 3)', () => {
  test('blocking asks for a reason, stores it, and it survives a reload', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    await page.goto(`/board?task=${t1}`)
    const card = page.getByTestId(`task-${t1}`)
    await expect(card).toBeVisible()

    await card.getByLabel(/Move .* to another lane/).selectOption('blocked')
    // Nothing is written until a reason is given.
    expect(runSql(`select state from tasks where id = '${t1}'`).trim()).toBe('todo')
    const form = page.getByTestId(`task-block-form-${t1}`)
    await form.getByLabel(/Why is/).fill('Waiting for the sponsor quote')
    await form.getByRole('button', { name: 'Block task' }).click()

    await expect
      .poll(() => runSql(`select state || '|' || blocked_reason || '|' || (blocked_since is not null) from tasks where id = '${t1}'`).trim())
      .toBe('blocked|Waiting for the sponsor quote|true')

    await page.reload()
    await expect(page.getByTestId(`task-blocked-${t1}`)).toContainText('Waiting for the sponsor quote')
  })

  test('a prerequisite in another department is linked and shown on the Gantt; the reverse link is never offered', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    await page.goto(`/board?task=${t1}`)
    const panel = page.getByTestId(`task-details-${t1}`)
    await expect(panel).toBeVisible()
    await panel.getByLabel(/Add a prerequisite/).selectOption({ label: `${T2} — ${m.departments.headB.name}` })
    await panel.getByRole('button', { name: 'Add prerequisite' }).click()
    await expect(panel.getByTestId(`task-prereq-${t1}-${t2}`)).toBeVisible()
    expect(runSql(`select count(*) from task_dependencies where task_id = '${t1}' and depends_on_task_id = '${t2}'`).trim()).toBe('1')

    // Persistence after a reload, and the Gantt shows the same canonical task with its prerequisite.
    await page.reload()
    await expect(page.getByTestId(`task-prereq-${t1}-${t2}`)).toBeVisible()
    await page.goto(`/gantt?open=${encodeURIComponent(m.milestoneKey)}&sections=unsectioned:${encodeURIComponent(m.milestoneKey)}&task=${t1}`)
    await expect(page.getByTestId(`gantt-waits-${t1}`)).toContainText('Waits for 1')
    await expect(page.getByTestId(`gantt-prereqs-${t1}`)).toContainText(T2)

    // The other department's Head cannot make the prerequisite wait for the first
    // task: a circle is not even offered as a choice, and nothing is written.
    await login(page, m.users.headB.email, m.password)
    await page.goto(`/board?task=${t2}`)
    const panelB = page.getByTestId(`task-details-${t2}`)
    await expect(panelB).toBeVisible()
    const offered = await panelB.getByLabel(/Add a prerequisite/).locator('option').allTextContents()
    expect(offered.some((o) => o.startsWith(T1))).toBe(false)
    expect(runSql(`select count(*) from task_dependencies where task_id = '${t2}'`).trim()).toBe('0')
  })

  test('a save from a stale screen is refused, not written over the newer change', async ({ page }) => {
    const m = readManifest()
    // Cut the live-update socket so this page really is a stale screen (with it,
    // realtime would refresh the page first and the save would be a plain
    // field-level merge onto the newer row).
    await page.routeWebSocket(/realtime/, () => undefined)
    await login(page, m.users.member.email, m.password)
    await page.goto(`/board?task=${t1}`)
    const panel = page.getByTestId(`task-details-${t1}`)
    await expect(panel).toBeVisible()
    await panel.getByLabel('Description').fill('My edit from a stale screen')

    // Someone else changes the task after this page loaded (out of band).
    runSql(`update tasks set title = '${PREFIX} renamed elsewhere' where id = '${t1}'`)

    await panel.getByTestId(`task-save-${t1}`).click()
    await expect(page.getByRole('alert').first()).toContainText(/changed by someone else/i, { timeout: 10_000 })
    expect(runSql(`select coalesce(detail, '') from tasks where id = '${t1}'`).trim()).not.toContain('My edit from a stale screen')
  })
})
