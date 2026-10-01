import { test, expect } from '@playwright/test'
import { readManifest, runSql } from './setup/db.ts'
import { login } from './setup/login.ts'

// Backend completion Phase 4, through a real browser against the real local database:
//  1. readiness is a person's confirmation of ONE current measurement and lapses by itself when a
//     newer measurement arrives (passing the rule confirms nothing);
//  2. a milestone's submission and acceptance are dates a person records, separate from its work;
//  3. starting a season copies only the milestone structure, never makes it current, and is
//     President/Developer only.
// Every fixture is created here and removed in afterEach; nothing is shared with the other specs.

const today = () => new Date().toLocaleDateString('en-CA')

function dropSpec(specId: string) {
  runSql(`alter table spec_readiness disable trigger trg_guard_spec_readiness_rows`)
  runSql(`alter table spec_measurements disable trigger trg_guard_spec_measurement_rows`)
  runSql(`alter table specs disable trigger trg_guard_spec_current_cache`)
  try {
    runSql(`update specs set current_measurement_id = null where id = '${specId}'`)
    runSql(`delete from spec_readiness where spec_id = '${specId}'`)
    runSql(`delete from spec_measurements where spec_id = '${specId}'`)
    runSql(`delete from specs where id = '${specId}'`)
  } finally {
    runSql(`alter table specs enable trigger trg_guard_spec_current_cache`)
    runSql(`alter table spec_measurements enable trigger trg_guard_spec_measurement_rows`)
    runSql(`alter table spec_readiness enable trigger trg_guard_spec_readiness_rows`)
  }
}

test.describe('readiness is a confirmation, not a score (R25-R28, Phase 4)', () => {
  let specId = ''
  test.beforeEach(async ({}, testInfo) => {
    const m = readManifest()
    specId = runSql(
      `insert into specs (season_id, parameter, comparator, target, unit, direction, direction_reviewed_at, direction_note, plausible_min, plausible_max) ` +
        `values ('${m.season.id}', 'E2E Readiness (Phase 4 ${testInfo.project.name})', 'min', 10, 'kg', 'higher_better', now(), 'E2E fixture: reviewed', 0, 500) returning id`,
    ).trim().split('\n')[0]
  })
  test.afterEach(() => {
    if (specId) dropSpec(specId)
  })

  test('passing alone is amber; a developer confirms the exact measurement; a newer one lapses it', async ({ page }) => {
    const m = readManifest()
    const live = () => runSql(`select count(*) from spec_readiness where spec_id = '${specId}' and revoked_at is null`).trim()

    // A member may record measurements but not confirm readiness.
    await login(page, m.users.member.email, m.password)
    await page.goto(`/specs?open=${specId}`)
    const row = page.getByTestId(`spec-${specId}`)
    await row.getByLabel('New measurement (kg)').fill('12')
    await row.getByRole('button', { name: 'Review' }).click()
    await row.getByRole('button', { name: 'Save measurement' }).click()
    await expect(row).toHaveAttribute('data-verdict', 'pass', { timeout: 10_000 })
    // It passes, and that is all: nobody has checked it.
    await expect(row).toHaveAttribute('data-zone', 'amber')
    await expect(page.getByTestId(`readiness-${specId}`)).toHaveAttribute('data-readiness', 'not_confirmed')
    await expect(page.getByTestId(`confirm-ready-${specId}`)).toHaveCount(0)

    // A developer confirms the current measurement with a note.
    await login(page, m.users.developer.email, m.password)
    await page.goto(`/specs?open=${specId}`)
    const devRow = page.getByTestId(`spec-${specId}`)
    await expect(page.getByTestId(`confirm-ready-${specId}`)).toBeDisabled() // no note yet
    await devRow.getByLabel('What was checked?').fill('Weighed twice on the calibrated scale.')
    await page.getByTestId(`confirm-ready-${specId}`).click()
    await expect(page.getByTestId(`readiness-${specId}`)).toHaveAttribute('data-readiness', 'ready', { timeout: 10_000 })
    await expect(devRow).toHaveAttribute('data-zone', 'green')
    expect(live(), 'one live confirmation').toBe('1')

    // A newer measurement replaces the one that was checked: the confirmation lapses, durably.
    // A developer also sees the separate competition editor; the team one is the first.
    const teamEditor = page.getByTestId(`measurement-editor-${specId}`)
    await teamEditor.getByLabel('New measurement (kg)').fill('13')
    await teamEditor.getByRole('button', { name: 'Review' }).click()
    await teamEditor.getByRole('button', { name: 'Save measurement' }).click()
    await expect(page.getByTestId(`readiness-${specId}`)).toHaveAttribute('data-readiness', 'lapsed', { timeout: 10_000 })
    await expect(devRow).toHaveAttribute('data-zone', 'amber')
    expect(live(), 'no live confirmation after a newer measurement').toBe('0')
    expect(runSql(`select count(*) from spec_readiness where spec_id = '${specId}' and revoked_at is not null`).trim()).toBe('1')
  })
})

test.describe('milestone work, submission and acceptance are three facts (Phase 4)', () => {
  test('recording a submission does not touch the work figure, and acceptance needs a submission', async ({ page }) => {
    const m = readManifest()
    const key = m.milestoneKey
    const restore = () =>
      runSql(
        `select set_config('reqon.milestone_submission_write', 'on', false); ` +
          `update milestones set submitted_on = null, submitted_by = null, accepted_on = null, accepted_by = null where key = '${key}'`,
      )
    try {
      await login(page, m.users.developer.email, m.password)
      await page.goto('/milestones')
      await expect(page.getByTestId(`work-${key}`)).not.toHaveText('loading…', { timeout: 10_000 })
      const workBefore = await page.getByTestId(`work-${key}`).innerText()
      await expect(page.getByTestId(`submitted-${key}`)).toContainText('Not recorded')
      await expect(page.getByTestId(`accepted-${key}`)).toContainText('Not recorded')

      await page.getByTestId(`submission-edit-${key}`).click()
      // Acceptance without a submission is refused before anything is sent.
      await page.getByLabel('Accepted on').fill(today())
      await expect(page.getByTestId(`submission-problem-${key}`)).toContainText('cannot be accepted before it was submitted')
      await page.getByLabel('Accepted on').fill('')

      await page.getByLabel('Submitted on').fill(today())
      await page.getByRole('button', { name: /^Save record for/ }).click()
      await expect(page.getByTestId(`submitted-${key}`)).not.toContainText('Not recorded', { timeout: 10_000 })
      await expect(page.getByTestId(`accepted-${key}`)).toContainText('Not recorded')
      expect(await page.getByTestId(`work-${key}`).innerText(), 'submitting does not change the work figure').toBe(workBefore)
      expect(runSql(`select submitted_on is not null and accepted_on is null from milestones where key = '${key}'`).trim()).toBe('t')
    } finally {
      restore()
    }
  })

  test('a member without milestone authority sees the facts but has no way to record them', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    await page.goto('/milestones')
    await expect(page.getByTestId(`submitted-${m.milestoneKey}`)).toBeVisible()
    await expect(page.getByTestId(`submission-edit-${m.milestoneKey}`)).toHaveCount(0)
  })
})

test.describe('starting a season (Phase 4)', () => {
  test('a developer starts one with the structure copied; it is not current and carries no dates', async ({ page }, testInfo) => {
    const m = readManifest()
    const label = `E2E ${testInfo.project.name} ${Date.now()}`
    let newId = ''
    try {
      await login(page, m.users.developer.email, m.password)
      await page.goto('/settings')
      await page.locator('#new-season-label').fill(label)
      await expect(page.getByTestId('copy-structure')).toBeEnabled({ timeout: 10_000 })
      await expect(page.getByTestId('copy-structure')).toBeChecked()
      await page.getByRole('button', { name: 'Create season' }).click()
      await expect.poll(() => runSql(`select id from seasons where label = '${label}'`).trim(), { timeout: 10_000 }).not.toBe('')
      newId = runSql(`select id from seasons where label = '${label}'`).trim()

      expect(runSql(`select is_current from seasons where id = '${newId}'`).trim(), 'never becomes current by itself').toBe('f')
      expect(runSql(`select id from seasons where is_current`).trim(), 'the club stays on its season').toBe(m.season.id)
      const copied = runSql(
        `select (select count(*) from milestones where season_id = '${newId}') || '|' || ` +
          `(select count(*) from milestones where season_id = '${m.season.id}') || '|' || ` +
          `(select count(*) from milestones n join milestones o on o.season_id = '${m.season.id}' and o.code = n.code where n.season_id = '${newId}') || '|' || ` +
          `(select count(*) from milestones where season_id = '${newId}' and (submitted_on is not null or accepted_on is not null or opens_on is not null or due_on is not null))`,
      ).trim()
      const [n, o, matched, dated] = copied.split('|').map(Number)
      expect(n, 'every milestone definition was copied').toBe(o)
      expect(matched, 'under the same display codes').toBe(o)
      expect(dated, 'with no dates or submission carried over').toBe(0)
      expect(runSql(`select count(*) from tasks where season_id = '${newId}'`).trim(), 'and no work').toBe('0')
    } finally {
      if (newId) {
        runSql(`delete from milestone_sections where milestone_key in (select key from milestones where season_id = '${newId}')`)
        runSql(`delete from milestones where season_id = '${newId}'`)
        // A season that holds history cannot be deleted by design; this one was a fixture, so its
        // own "season started" event goes with it and the guard is paused for that one statement set.
        runSql(`alter table seasons disable trigger trg_guard_season_delete`)
        try {
          runSql(`delete from activity where season_id = '${newId}'`)
          runSql(`delete from seasons where id = '${newId}'`)
        } finally {
          runSql(`alter table seasons enable trigger trg_guard_season_delete`)
        }
      }
    }
  })

  test('a member is not offered season creation', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    await page.goto('/settings')
    await expect(page.getByRole('button', { name: 'Create season' })).toHaveCount(0)
  })
})
