import { describe, expect, it } from 'vitest'
import type { PresentableSpec } from './presentation.ts'
import {
  acceptableLabel,
  comparisonItems,
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
    expect(zoneCue('green')).toEqual({ icon: '✓', label: 'Passes the rule · goal met', tone: 'green' })
    expect(zoneCue('amber').label).toBe('Passes the rule · goal not met')
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
