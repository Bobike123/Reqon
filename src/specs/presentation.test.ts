import { describe, expect, it } from 'vitest'
import type { PresentableSpec } from './presentation.ts'
import {
  acceptableLabel,
  comparisonItems,
  competitionCell,
  readinessPresentation,
  idealCell,
  projectGoalText,
  regulatoryLimitText,
  zoneCue,
} from './presentation.ts'

const BASE = {
  id: 'spec', season_id: 'season', parameter: 'Parameter', condition: null, clause_key: null, sort_order: 0,
  direction: 'higher_better', measure_kind: 'numeric', comparator: 'min', unit: 'kW',
  measured: null, measured_bool: null, measured_at: null, measured_by: null, current_measurement_id: null,
  acceptable: null, goal: null, goal_max: null, goal_tolerance: null, goal_bool: null, ideal: null,
  plausible_min: null, plausible_max: null,
  target: null, target_max: null, target_bool: null, target_text: null, target_tolerance: null,
  target_min_inclusive: true, target_max_inclusive: true,
  verdict: 'unmeasured', goal_status: 'unmeasured', zone: 'grey',
  direction_reviewed_at: null, direction_reviewed_by: null, direction_note: null, direction_needs_review: false,
  readiness: 'not_confirmed', readiness_reason: null, readiness_confirmed_at: null, readiness_confirmed_by: null,
  readiness_note: null, readiness_measurement_id: null, readiness_revoked_at: null,
  competition_measurement_id: null, competition_value: null, competition_value_bool: null,
  competition_measured_at: null, competition_verdict: null,
} satisfies PresentableSpec

describe('spec comparison presentation', () => {
  it('labels higher- and lower-is-better acceptable thresholds accurately', () => {
    expect(acceptableLabel('higher_better')).toBe('Minimum acceptable')
    expect(acceptableLabel('lower_better')).toBe('Maximum acceptable')
    expect(acceptableLabel('range')).toBe('Acceptable threshold')

    const higher = comparisonItems({ ...BASE, acceptable: 70, goal: 80, ideal: 90 })
    expect(higher.map(({ label, value }) => [label, value])).toContainEqual(['Minimum acceptable', '70 kW'])

    const lower = comparisonItems({ ...BASE, direction: 'lower_better', acceptable: 158, goal: 145, ideal: 138, unit: 'kg' })
    expect(lower.map(({ label, value }) => [label, value])).toContainEqual(['Maximum acceptable', '158 kg'])
  })

  it('shows range bounds and their regulatory inclusivity without inventing an acceptable or ideal target', () => {
    const spec: PresentableSpec = {
      ...BASE, direction: 'range', comparator: 'range', goal: 10, goal_max: 20,
      target: 1, target_max: 99, target_min_inclusive: false, target_max_inclusive: true, unit: null,
    }
    expect(projectGoalText(spec)).toBe('[10, 20]')
    expect(regulatoryLimitText(spec)).toBe('(1, 99]')
    expect(comparisonItems(spec).map((item) => item.key)).toEqual(['current', 'goal', 'regulatory'])
  })

  it('shows exact targets with declared tolerances and keeps units on both', () => {
    const spec: PresentableSpec = {
      ...BASE, direction: 'exact', comparator: 'eq', goal: 50, goal_tolerance: 2,
      target: 55, target_tolerance: 1, unit: '°C',
    }
    expect(projectGoalText(spec)).toBe('50 ± 2 °C')
    expect(regulatoryLimitText(spec)).toBe('= 55 ± 1 °C')
  })

  it('presents boolean goals and rules as Yes/No rather than numeric values', () => {
    const spec: PresentableSpec = {
      ...BASE, direction: 'boolean', measure_kind: 'boolean', comparator: 'bool',
      goal_bool: true, target_bool: false, unit: null,
    }
    expect(projectGoalText(spec)).toBe('Yes')
    expect(regulatoryLimitText(spec)).toBe('Must be No')
    expect(comparisonItems(spec).map((item) => item.key)).toEqual(['current', 'goal', 'regulatory'])
  })

  it('distinguishes an unmeasured current value, absent project target, and incomplete regulatory rule', () => {
    const rows = Object.fromEntries(comparisonItems(BASE).map((item) => [item.key, item]))
    expect(rows.current).toMatchObject({ value: 'Not measured', missing: true })
    expect(rows.goal).toMatchObject({ value: 'Not set', missing: true })
    expect(rows.regulatory).toMatchObject({ value: 'Rule incomplete', missing: true })
  })
})

describe('compact table helpers', () => {
  const base = {
    unit: 'kg', direction: 'lower_better', ideal: 138, goal: 145, goal_max: null, goal_tolerance: null, goal_bool: null,
  } as unknown as PresentableSpec
  it('names the zone in words, and never as an approval', () => {
    expect(zoneCue('green')).toEqual({ icon: '✓', label: 'Passes the rule · confirmed ready', tone: 'green' })
    expect(zoneCue('amber').label).toBe('Passes the rule · not confirmed ready')
    expect(zoneCue('red').label).toBe('Fails the rule')
    expect(zoneCue(null)).toMatchObject({ tone: 'grey', label: 'Not judged yet' })
    for (const zone of ['green', 'amber', 'red', null]) expect(zoneCue(zone).label).not.toMatch(/approv|accept/i)
  })
  it('uses the spec\'s own ideal when it has one, and the project goal otherwise', () => {
    expect(idealCell(base)).toEqual({ value: '138 kg', note: null })
    expect(idealCell({ ...base, ideal: null })).toBeNull()
    // Zero is a value.
    expect(idealCell({ ...base, ideal: 0 })).toEqual({ value: '0 kg', note: null })
    expect(idealCell({ ...base, direction: 'range', goal: 10, goal_max: 20 } as PresentableSpec)).toEqual({ value: '[10, 20] kg', note: 'project goal' })
    expect(idealCell({ ...base, direction: 'boolean', goal_bool: null } as PresentableSpec)).toBeNull()
  })
})

describe('readiness and competition presentation', () => {
  const day = (iso: string) => iso.slice(0, 10)

  it('says ready with the day and the note, and never "ready" for a lapsed confirmation', () => {
    expect(readinessPresentation({ readiness: 'ready', readiness_reason: null, readiness_confirmed_at: '2026-10-01T10:00:00Z', readiness_note: 'Weighed' }, day))
      .toEqual({ state: 'ready', label: 'Confirmed ready on 2026-10-01', detail: 'Weighed' })
    const lapsed = readinessPresentation({ readiness: 'lapsed', readiness_reason: 'A newer measurement became the current one.', readiness_confirmed_at: '2026-10-01T10:00:00Z', readiness_note: 'Weighed' }, day)
    expect(lapsed.state).toBe('lapsed')
    expect(lapsed.label).toBe('Was ready on 2026-10-01 — no longer')
    expect(lapsed.label).not.toMatch(/^Confirmed/)
    expect(lapsed.detail).toBe('A newer measurement became the current one.')
  })

  it('treats a missing readiness answer as unknown, not as confirmed', () => {
    expect(readinessPresentation({ readiness: null, readiness_reason: null, readiness_confirmed_at: null, readiness_note: null }, day).state).toBe('unknown')
    expect(readinessPresentation({ readiness: 'not_confirmed', readiness_reason: null, readiness_confirmed_at: null, readiness_note: null }, day).state).toBe('not_confirmed')
  })

  it('the row cue never calls a pass "ready" unless the zone is green', () => {
    expect(zoneCue('amber').label).toBe('Passes the rule · not confirmed ready')
    expect(zoneCue('green').label).toBe('Passes the rule · confirmed ready')
    expect(zoneCue('grey').label).toBe('Not judged yet')
  })

  it('shows a competition observation apart from ours, with its own verdict, and nothing when there is none', () => {
    expect(competitionCell(BASE)).toBeNull()
    expect(competitionCell({ ...BASE, competition_measurement_id: 'c1', competition_value: 90, unit: 'kg', competition_verdict: 'fail' }))
      .toEqual({ value: '90 kg', verdict: 'Fails the rule' })
    expect(competitionCell({ ...BASE, direction: 'boolean', comparator: 'bool', competition_measurement_id: 'c2', competition_value_bool: true, competition_verdict: 'pass' }))
      .toEqual({ value: 'Yes', verdict: 'Passes the rule' })
  })
})
