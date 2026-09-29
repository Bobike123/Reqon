import { test, expect } from '@playwright/test'
import { readManifest, runSql } from './setup/db.ts'
import { login } from './setup/login.ts'

// Phase 13's mass-measurement scenario, real browser against the real local
// database. The mass spec is the documented fixture (regulatory max 160 kg,
// acceptable upper bound 158 kg, goal 145 kg, ideal 138 kg, explicit save
// 153.2 kg) from Phase 9/10's own tests; three more synthetic specs cover
// higher-is-better, exact and range comparators, and a fourth covers
// boolean — see global-setup.ts. Every scenario asserts: (a) typing or
// leaving the field creates nothing, (b) only an explicit Save records
// exactly one row, (c) malformed/implausible input is refused with no row,
// (d) Current, the regulatory verdict and (where applicable) the goal zone
// agree with the server's own computed answer — never the same helper used
// to compute both the actual and the expected value.
//
// Counts below are DELTAS against a captured baseline, not absolute totals:
// global-setup/teardown run once per Playwright invocation, shared by both
// spec files and both viewport projects, so a spec that ran earlier in the
// same invocation may already have recorded rows against these fixtures.
function countFor(specId: string): number {
  return Number(runSql(`select count(*) from spec_measurements where spec_id = '${specId}'`).trim())
}

test.describe('mass-measurement flow (R25-R28, R44)', () => {
  test('typing and blur write nothing; malformed/implausible input is refused; an explicit Save records exactly one observation', async ({
    page,
  }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    await page.goto('/specs')

    const row = page.getByTestId(`spec-${m.spec.id}`)
    await expect(row).toBeVisible()
    // The compact table opens a row into its editor (the row stays open in the
    // address: ?open=<id>).
    await row.getByTestId(`spec-toggle-${m.spec.id}`).click()
    await expect(page).toHaveURL(new RegExp(`open=${m.spec.id}`))
    const baseline = countFor(m.spec.id)

    // ---- Implausible input (below plausible_min=50) is refused, no row ----
    const input = row.getByLabel('New measurement (kg)')
    await input.fill('10')
    await row.getByRole('button', { name: 'Review' }).click()
    await expect(row.getByTestId(`input-error-${m.spec.id}`)).toBeVisible()
    await expect(row.getByTestId(`confirm-${m.spec.id}`)).toHaveCount(0)
    expect(countFor(m.spec.id), 'implausible input creates no row').toBe(baseline)

    // ---- Typing a plausible value, then navigating away without Save: nothing recorded ----
    await input.fill('')
    await input.fill('170')
    await page.goto('/board')
    await page.goto(`/specs?open=${m.spec.id}`)
    expect(countFor(m.spec.id), 'typing/navigating away without Save creates no row').toBe(baseline)

    // ---- An earlier observation (160 kg), then the explicit save of 153.2 kg ----
    // Two real points let the chart/progression render (TrendChart.tsx needs
    // >= 2 accepted numeric rows) and demonstrate Current tracking the
    // NEWEST measured time, not merely the last row inserted.
    const row1 = page.getByTestId(`spec-${m.spec.id}`)
    await row1.getByLabel('New measurement (kg)').fill('160')
    await row1.getByRole('button', { name: 'Review' }).click()
    await row1.getByRole('button', { name: 'Save measurement' }).click()
    await expect(row1.getByTestId(`confirm-${m.spec.id}`)).toHaveCount(0, { timeout: 10_000 })
    expect(countFor(m.spec.id), 'one explicit Save records exactly one new row').toBe(baseline + 1)

    const row2 = page.getByTestId(`spec-${m.spec.id}`)
    await row2.getByLabel('New measurement (kg)').fill('153.2')
    await row2.getByRole('button', { name: 'Review' }).click()
    await expect(row2.getByTestId(`confirm-${m.spec.id}`)).toContainText('Record 153.2 kg for E2E Vehicle Mass')
    await row2.getByRole('button', { name: 'Save measurement' }).click()
    await expect(row2.getByTestId(`confirm-${m.spec.id}`)).toHaveCount(0, { timeout: 10_000 })
    expect(countFor(m.spec.id), 'the second explicit Save records exactly one more new row').toBe(baseline + 2)

    const latestTwo = runSql(
      `select value_numeric, note is null, measured_by is not null from spec_measurements ` +
        `where spec_id = '${m.spec.id}' order by measured_at desc limit 2`,
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(latestTwo, 'the two just-saved rows, newest first').toEqual(['153.2|t|t', '160|t|t'])

    // Independent expected verdict, computed here from the fixture's own
    // numbers — not by calling the app's/SQL's verdict function — then
    // compared against what the server-rendered UI actually shows.
    // 153.2 <= 160 (regulatory max) => pass; 153.2 > 145 (goal) => goal not met.
    await expect(page.getByTestId(`spec-${m.spec.id}`)).toHaveAttribute('data-verdict', 'pass')
    await expect(page.getByTestId(`regulatory-status-${m.spec.id}`)).toContainText('Pass')
    await expect(page.getByTestId(`goal-status-${m.spec.id}`)).toContainText('Not met')
    await expect(page.getByTestId(`comparison-current-${m.spec.id}`)).toContainText('153.2 kg')

    // Current, history and chart agree (history/chart are behind a disclosure).
    // The progression line accumulates across every explicit Save this fixture
    // has ever received in this invocation, so it is checked for the latest
    // value rather than an exact full sequence.
    await page.getByTestId(`spec-${m.spec.id}`).getByRole('button', { name: 'Show history' }).click()
    await expect(page.getByTestId(`progression-${m.spec.id}`)).toContainText('153.2')
    const dbCurrent = runSql(
      `select measured, current_measurement_id = (select id from spec_measurements where spec_id = '${m.spec.id}' order by measured_at desc limit 1) from specs where id = '${m.spec.id}'`,
    ).trim()
    expect(dbCurrent).toBe('153.2|t')
  })

  test('higher-is-better, exact and range comparators, and a boolean spec, all record correctly through the real UI', async ({ page }) => {
    const m = readManifest()
    await login(page, m.users.member.email, m.password)
    const extra = [m.extraSpecs.higher.id, m.extraSpecs.exact.id, m.extraSpecs.range.id, m.extraSpecs.boolean.id]
    await page.goto(`/specs?open=${extra.join(',')}`)

    // Higher-is-better: 120 mm >= target 100 mm => pass.
    const higherRow = page.getByTestId(`spec-${m.extraSpecs.higher.id}`)
    await higherRow.getByLabel('New measurement (mm)').fill('120')
    await higherRow.getByRole('button', { name: 'Review' }).click()
    await higherRow.getByRole('button', { name: 'Save measurement' }).click()
    await expect(page.getByTestId(`regulatory-status-${m.extraSpecs.higher.id}`)).toContainText('Pass', { timeout: 10_000 })

    // Exact: |25.3 - 25| = 0.3 <= tolerance 0.5 => pass.
    const exactRow = page.getByTestId(`spec-${m.extraSpecs.exact.id}`)
    await exactRow.getByLabel('New measurement (mm)').fill('25.3')
    await exactRow.getByRole('button', { name: 'Review' }).click()
    await exactRow.getByRole('button', { name: 'Save measurement' }).click()
    await expect(page.getByTestId(`regulatory-status-${m.extraSpecs.exact.id}`)).toContainText('Pass', { timeout: 10_000 })

    // Range [1, 99] inclusive: 150 is outside it => a real, well-formed
    // measurement that still fails regulation (distinct from the earlier
    // "refused before it becomes a row" case).
    const rangeBaseline = countFor(m.extraSpecs.range.id)
    const rangeRow = page.getByTestId(`spec-${m.extraSpecs.range.id}`)
    await rangeRow.getByLabel('New measurement').fill('150')
    await rangeRow.getByRole('button', { name: 'Review' }).click()
    await rangeRow.getByRole('button', { name: 'Save measurement' }).click()
    await expect(page.getByTestId(`regulatory-status-${m.extraSpecs.range.id}`)).toContainText('Fail', { timeout: 10_000 })
    expect(countFor(m.extraSpecs.range.id), 'an out-of-range value still records one real row, just failing').toBe(rangeBaseline + 1)

    // Boolean: target_bool = true, recording "No" => fail.
    const boolRow = page.getByTestId(`spec-${m.extraSpecs.boolean.id}`)
    await boolRow.getByLabel('New measurement').selectOption('false')
    await boolRow.getByRole('button', { name: 'Review' }).click()
    await expect(boolRow.getByTestId(`confirm-${m.extraSpecs.boolean.id}`)).toContainText('Record No for E2E Kill Switch')
    await boolRow.getByRole('button', { name: 'Save measurement' }).click()
    await expect(page.getByTestId(`regulatory-status-${m.extraSpecs.boolean.id}`)).toContainText('Fail', { timeout: 10_000 })
  })
})
