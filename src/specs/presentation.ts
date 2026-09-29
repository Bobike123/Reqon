import type { Database } from '../lib/database.types.ts'

export type PresentableSpec = Database['public']['Views']['spec_verdicts']['Row']

export type ComparisonItem = {
  key: 'current' | 'acceptable' | 'goal' | 'ideal' | 'regulatory'
  label: string
  value: string
  missing: boolean
}

function withUnit(value: number | string, unit: string | null): string {
  return `${value}${unit ? ` ${unit}` : ''}`
}

export function measurementValue(
  numeric: number | null,
  bool: boolean | null,
  unit: string | null,
): string {
  if (bool !== null) return bool ? 'Yes' : 'No'
  if (numeric !== null) return withUnit(numeric, unit)
  return 'Not measured'
}

function boundedValue(
  minimum: number | null,
  maximum: number | null,
  minimumInclusive: boolean,
  maximumInclusive: boolean,
  unit: string | null,
): string | null {
  if (minimum === null || maximum === null) return null
  const left = minimumInclusive ? '[' : '('
  const right = maximumInclusive ? ']' : ')'
  return `${left}${minimum}, ${maximum}${right}${unit ? ` ${unit}` : ''}`
}

export function acceptableLabel(direction: string | null): string {
  if (direction === 'lower_better') return 'Maximum acceptable'
  if (direction === 'higher_better') return 'Minimum acceptable'
  return 'Acceptable threshold'
}

export function projectGoalText(spec: PresentableSpec): string | null {
  if (spec.direction === 'boolean') {
    return spec.goal_bool === null ? null : spec.goal_bool ? 'Yes' : 'No'
  }
  if (spec.direction === 'range') {
    return boundedValue(spec.goal, spec.goal_max, true, true, spec.unit)
  }
  if (spec.goal === null) return null
  if (spec.direction === 'exact' && spec.goal_tolerance !== null && spec.goal_tolerance > 0) {
    return withUnit(`${spec.goal} ± ${spec.goal_tolerance}`, spec.unit)
  }
  return withUnit(spec.goal, spec.unit)
}

export function regulatoryLimitText(spec: PresentableSpec): string | null {
  if (spec.comparator === 'bool') {
    return spec.target_bool === null ? null : spec.target_bool ? 'Must be Yes' : 'Must be No'
  }
  if (spec.comparator === 'range') {
    return boundedValue(
      spec.target,
      spec.target_max,
      spec.target_min_inclusive ?? true,
      spec.target_max_inclusive ?? true,
      spec.unit,
    )
  }
  if (spec.target === null) return null
  if (spec.comparator === 'eq') {
    const tolerance = spec.target_tolerance ?? 0
    return withUnit(tolerance > 0 ? `= ${spec.target} ± ${tolerance}` : `= ${spec.target}`, spec.unit)
  }
  const operator = spec.comparator === 'min' ? '≥' : spec.comparator === 'max' ? '≤' : '='
  return withUnit(`${operator} ${spec.target}`, spec.unit)
}

export function comparisonItems(spec: PresentableSpec): ComparisonItem[] {
  const items: ComparisonItem[] = [{
    key: 'current',
    label: 'Current',
    value: measurementValue(spec.measured, spec.measured_bool, spec.unit),
    missing: spec.measured === null && spec.measured_bool === null,
  }]

  if (spec.direction === 'higher_better' || spec.direction === 'lower_better') {
    items.push({
      key: 'acceptable',
      label: acceptableLabel(spec.direction),
      value: spec.acceptable === null ? 'Not set' : withUnit(spec.acceptable, spec.unit),
      missing: spec.acceptable === null,
    })
  }

  const goal = projectGoalText(spec)
  items.push({ key: 'goal', label: 'Project goal', value: goal ?? 'Not set', missing: goal === null })

  if (spec.direction === 'higher_better' || spec.direction === 'lower_better') {
    items.push({
      key: 'ideal',
      label: 'Ideal',
      value: spec.ideal === null ? 'Not set' : withUnit(spec.ideal, spec.unit),
      missing: spec.ideal === null,
    })
  }

  const regulatory = regulatoryLimitText(spec)
  items.push({
    key: 'regulatory',
    label: 'Regulatory limit',
    value: regulatory ?? 'Rule incomplete',
    missing: regulatory === null,
  })
  return items
}

export const DIRECTION_LABELS: Record<string, string> = {
  higher_better: 'Higher is better',
  lower_better: 'Lower is better',
  range: 'Target range',
  exact: 'Exact target',
  boolean: 'Yes / no characteristic',
}

export type StatusPresentation = { icon: string; label: string; tone: 'red' | 'amber' | 'green' | 'grey' }

export function regulatoryStatus(verdict: string | null): StatusPresentation {
  if (verdict === 'fail') return { icon: '✕', label: 'Regulatory rule: Fail', tone: 'red' }
  if (verdict === 'pass') return { icon: '✓', label: 'Regulatory rule: Pass', tone: 'green' }
  if (verdict === 'unevaluable') {
    return { icon: '?', label: 'Regulatory rule: Cannot be judged — rule incomplete', tone: 'grey' }
  }
  return { icon: '○', label: 'Regulatory rule: Not measured', tone: 'grey' }
}

export function projectStatus(status: string | null): StatusPresentation {
  if (status === 'met') return { icon: '◆', label: 'Project goal: Met', tone: 'green' }
  if (status === 'short') return { icon: '▲', label: 'Project goal: Not met', tone: 'amber' }
  if (status === 'unacceptable') {
    return { icon: '!', label: 'Project threshold: Outside acceptable target', tone: 'amber' }
  }
  if (status === 'not_set') return { icon: '—', label: 'Project goal: Not set', tone: 'grey' }
  return { icon: '○', label: 'Project goal: Not measured', tone: 'grey' }
}

export function zoneStatus(zone: string | null): StatusPresentation {
  if (zone === 'red') return { icon: '✕', label: 'Red zone — regulatory failure', tone: 'red' }
  if (zone === 'amber') return { icon: '▲', label: 'Amber zone — regulatory pass; project goal unmet', tone: 'amber' }
  if (zone === 'green') return { icon: '✓', label: 'Green zone — regulatory pass; project goal met', tone: 'green' }
  return { icon: '○', label: 'Grey zone — status unknown', tone: 'grey' }
}

// The row cue beside a parameter in the compact table: an icon and a few words,
// so the colour is never the only signal. It says what OUR measurement does
// against the rule and our goal — never that anyone has approved anything.
export function zoneCue(zone: string | null): StatusPresentation {
  if (zone === 'red') return { icon: '✕', label: 'Fails the rule', tone: 'red' }
  if (zone === 'amber') return { icon: '▲', label: 'Passes the rule · goal not met', tone: 'amber' }
  if (zone === 'green') return { icon: '✓', label: 'Passes the rule · goal met', tone: 'green' }
  return { icon: '○', label: 'Not judged yet', tone: 'grey' }
}

// The "Ideal" column. Higher/lower-is-better specs carry their own ideal; for a
// range, exact or yes/no characteristic the project goal is the ideal, and the
// cell says so. null when nothing is set.
export function idealCell(spec: PresentableSpec): { value: string; note: string | null } | null {
  if (spec.direction === 'higher_better' || spec.direction === 'lower_better') {
    return spec.ideal === null ? null : { value: withUnit(spec.ideal, spec.unit), note: null }
  }
  const goal = projectGoalText(spec)
  return goal === null ? null : { value: goal, note: 'project goal' }
}

// Only the thresholds the compact row does not already show (it shows current,
// ideal and the regulatory limit).
export function thresholdItems(spec: PresentableSpec): ComparisonItem[] {
  return comparisonItems(spec).filter((item) => item.key === 'acceptable' || item.key === 'goal')
}
