import { test, expect, type Page } from '@playwright/test'
import { readManifest, runSql } from './setup/db.ts'
import { deleteProposalsWhere } from './setup/cleanup.ts'
import { chooseDepartment, openProposalForm } from './setup/departments.ts'
import { login } from './setup/login.ts'

// Phase 13: two real browser sessions, proving changes propagate to an idle
// screen through Supabase Realtime — never through a page.reload() — and a
// season switch never leaks or mutates old-season data once picked up.
const TITLE = `[E2E Phase13 RT] Realtime suspension review ${Date.now()}`

test.describe('two-session realtime propagation and season switching (R38-R39)', () => {
  test('promotion, an owner change and archival reach an idle Board without reload', async ({ browser }) => {
    test.setTimeout(60_000)
    const m = readManifest()
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA: Page = await ctxA.newPage()
    const pageB: Page = await ctxB.newPage()

    try {
      // Session A: an idle observer on the Board, watching every department.
      await login(pageA, m.users.member.email, m.password)
      await pageA.goto('/board')
      await pageA.getByRole('button', { name: /^All tasks/ }).click()
      await chooseDepartment(pageA, m.departments.headA.key, m.departments.headA.name)

      // Session B: raise, then (as its Head) promote — a fresh authenticated
      // session, not the same tab reused, so this is a genuine two-actor scenario.
      await login(pageB, m.users.member.email, m.password)
      await pageB.goto('/proposals')
      const raiseForm = await openProposalForm(pageB)
      await raiseForm.getByLabel('Title').fill(TITLE)
      await raiseForm.getByLabel('Department').selectOption(m.departments.headA.key)
      await raiseForm.getByLabel('Proposed owner').selectOption(m.users.member.id)
      const deadline = new Date()
      deadline.setDate(deadline.getDate() + 30)
      await raiseForm.getByLabel('Deadline').fill(deadline.toISOString().slice(0, 10))
      await raiseForm.getByLabel('Related milestone').selectOption(m.milestoneKey)
      await raiseForm.getByLabel('Find a requirement').fill('F.13.3.1')
      await raiseForm.getByRole('checkbox', { name: /F\.13\.3\.1/ }).check()
      await raiseForm.getByRole('button', { name: 'Raise proposal' }).click()
      await expect(pageB.getByText('Proposal raised.')).toBeVisible()

      await login(pageB, m.users.headA.email, m.password)
      await pageB.goto('/proposals')
      const proposalId = runSql(`select id from task_proposals where title = '${TITLE}'`).trim()
      await pageB.getByTestId(`review-open-${proposalId}`).click()
      await pageB.getByLabel('Review note').fill('Approved for implementation in this department.')
      await pageB.getByTestId('review-approve').click()
      await expect(pageB.getByTestId('review-approve')).toHaveCount(0, { timeout: 10_000 })
      await expect.poll(() => runSql(`select state from task_proposals where id = '${proposalId}'`).trim()).toBe('approved')
      await pageB.getByTestId(`review-open-${proposalId}`).click()
      await pageB.getByTestId('review-promote').click()
      await expect(pageB.getByTestId('review-promote')).toHaveCount(0, { timeout: 10_000 })

      const taskId = runSql(`select id from tasks where source_proposal = '${proposalId}'`).trim()
      expect(taskId, 'promotion must create the task').not.toBe('')

      // Session A never reloaded or navigated since it opened the Board —
      // the new task must reach it purely through the realtime subscription.
      await expect(pageA.getByTestId(`task-${taskId}`)).toBeVisible({ timeout: 10_000 })

      // Session B (Head A) reassigns the owner to Head B, an active member
      // of a different department reused here purely as "someone else".
      await pageB.goto('/board')
      await pageB.getByTestId(`task-more-${taskId}`).getByText('Details and edit', { exact: true }).click()
      await expect(pageB.getByLabel('Owner', { exact: true })).toBeVisible({ timeout: 5_000 })
      await pageB.getByLabel('Owner', { exact: true }).selectOption(m.users.headB.id)
      await pageB.getByTestId(`task-save-${taskId}`).click()
      await expect.poll(() => runSql(`select owner_id from tasks where id = '${taskId}'`).trim()).toBe(m.users.headB.id)
      // Reflected live on A's still-open card, no reload.
      await expect(pageA.getByTestId(`task-${taskId}`)).toContainText('E2E e2e-head-b', { timeout: 10_000 })

      // Archive it (a real Head action, same still-open panel) and confirm A drops it live too.
      await pageB.getByTestId(`task-archive-${taskId}`).click()
      await pageB.getByTestId(`task-archive-confirm-${taskId}`).click()
      await expect(pageA.getByTestId(`task-${taskId}`)).toHaveCount(0, { timeout: 10_000 })
    } finally {
      runSql(`delete from tasks where title = '${TITLE}'`)
      deleteProposalsWhere(`title = '${TITLE}'`)
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('switching the current season shows the new season cleanly, with nothing from the old one', async ({ page }) => {
    const m = readManifest()
    // Season-scoped React Query keys are namespaced by seasonId (queryKeys.ts:
    // every season-scoped key is `['season', seasonId, ...]`), so a season
    // switch cannot merge or mutate another season's cached data — switching
    // simply lands on a different key. useCurrentSeason() itself has a 5-minute
    // staleTime and no realtime channel (`seasons` is not in the realtime
    // publication), so — by design, not by defect — a switch is picked up on
    // the next navigation/reload, not pushed live. This test proves the
    // reload path is clean, which is the actual guarantee the invariant needs.
    await login(page, m.users.member.email, m.password)
    await page.goto('/milestones')
    const seasonBadge = page.locator('[data-tutorial="season-badge"]')
    await expect(seasonBadge).toContainText(m.season.label)

    expect(m.otherSeason.id, 'global-setup must provide a second season').not.toBe('')
    // Inside the try: if either statement fails, the finally still makes the
    // fixture season current again, so one failure cannot leave the whole run
    // without a current season.
    try {
      runSql(`update seasons set is_current = false where is_current`)
      runSql(`update seasons set is_current = true where id = '${m.otherSeason.id}'`)
      await page.reload()
      await expect(seasonBadge).toContainText(m.otherSeason.label, { timeout: 10_000 })
      // Nothing from the fixture's real season (its milestone key, created
      // above under the FIRST season) should appear under the new one.
      await expect(page.getByText(m.milestoneKey, { exact: false })).toHaveCount(0)
    } finally {
      runSql(`update seasons set is_current = false where is_current and id <> '${m.season.id}'`)
      runSql(`update seasons set is_current = true where id = '${m.season.id}'`)
    }
  })
})
