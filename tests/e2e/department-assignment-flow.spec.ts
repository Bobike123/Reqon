import { test, expect } from '@playwright/test'
import { readManifest, runSql } from './setup/db.ts'
import { login } from './setup/login.ts'

// Phase 6 finding F6-01, in a real browser against the real (local) database: an unclassified task
// (every hosted task is one) is given a department from the Board by the Vice President through
// set_task_department, with the reason kept in the history; a plain member is offered no such control,
// and a direct API call by that member is refused by the database itself.
const PREFIX = '[E2E Phase6 department]'
const TITLE = `${PREFIX} unclassified`

let taskId = ''
test.beforeEach(() => {
  const m = readManifest()
  taskId = runSql(
    `insert into tasks (season_id, title, state, owner_id, milestone_key, starts_on, due_date)
     values ('${m.season.id}', '${TITLE}', 'todo', '${m.users.member.id}', '${m.milestoneKey}', current_date + 5, current_date + 20)
     returning id`,
  ).trim().split('\n')[0]
})
test.afterEach(() => {
  runSql(`delete from activity where entity = 'task' and entity_id in (select id::text from tasks where title like '${PREFIX}%')`)
  runSql(`delete from tasks where title like '${PREFIX}%'`)
})

test.describe('giving a task a department (F6-01)', () => {
  test('the Vice President classifies an unassigned task with a reason; the history keeps it', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.vicepresident.email, m.password)
    await page.goto(`/board?task=${taskId}`)
    const panel = page.getByTestId(`task-department-${taskId}`)
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('No department yet.')
    await panel.getByLabel('Give it a department').selectOption({ label: m.departments.headA.name })
    const move = panel.getByRole('button', { name: 'Move task' })
    await expect(move).toBeDisabled() // a reason is required
    await panel.getByLabel('Why? (kept in the history)').fill('Mechanical owns the frame jig')
    await move.click()
    await expect(panel.getByRole('status')).toContainText(`Moved to ${m.departments.headA.name}.`)

    await expect.poll(() => runSql(`select subteam_key from tasks where id = '${taskId}'`).trim()).toBe(m.departments.headA.key)
    expect(
      runSql(`select count(*) from activity where entity = 'task' and entity_id = '${taskId}' and detail::text like '%Mechanical owns the frame jig%'`).trim(),
    ).toBe('1')
  })

  test('a plain member is offered no department control, and the database refuses the command anyway', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    await page.goto(`/board?task=${taskId}`)
    await expect(page.getByTestId(`task-details-${taskId}`)).toBeVisible()
    await expect(page.getByTestId(`task-department-${taskId}`)).toHaveCount(0)

    // The same command, sent directly by this signed-in member through the app's own client.
    const error = await page.evaluate(async ({ id, key }) => {
      const { supabase } = await import('/src/lib/supabase.ts')
      const { error } = await supabase.rpc('set_task_department', { p_task_id: id, p_subteam_key: key, p_reason: 'sneaky' })
      return error?.code ?? null
    }, { id: taskId, key: m.departments.headA.key })
    expect(error).toBe('42501')
    expect(runSql(`select coalesce(subteam_key, 'none') from tasks where id = '${taskId}'`).trim()).toBe('none')
  })

  // Role hierarchy (20260130000000): the Vice President ranks above every Head, so they edit a member's task in a
  // department that HAS a Head (MECH, headed by the fixture Head A); the Head of another department still cannot.
  test('the Vice President edits a member\'s task in a department that has a Head; another Head cannot', async ({ page }) => {
    const m = readManifest()
    // Fixture only: the department is set the way set_task_department does it (an internal write the guard allows).
    runSql(`begin; set local reqon.task_lifecycle_write = 'on'; update tasks set subteam_key = '${m.departments.headA.key}' where id = '${taskId}'; commit;`)
    await login(page, m.users.vicepresident.email, m.password)
    await page.goto(`/board?task=${taskId}`)
    const card = page.getByTestId(`task-${taskId}`)
    await card.getByLabel(/Move .* to another lane/).selectOption('wip')
    await expect.poll(() => runSql(`select state from tasks where id = '${taskId}'`).trim()).toBe('wip')

    await login(page, m.users.headB.email, m.password)
    await page.goto(`/board?task=${taskId}`)
    await expect(page.getByTestId(`task-details-${taskId}`)).toBeVisible()
    await expect(page.getByTestId(`task-${taskId}`).getByLabel(/Move .* to another lane/)).toHaveCount(0)
  })
})
