import type { Milestone } from '../../data/useMilestones.ts'
import type { Attention, SubteamProgress } from '../../data/useNowMetrics.ts'
import type { Topic } from '../../data/useTopics.ts'

// Every instrument on the Now screen, and the SQL that reproduces it.
// The queries themselves are in docs/now-metrics.sql — paste one into the
// Supabase SQL editor and it must agree with the tile. Nothing here invents a
// number; each function is the minimum arithmetic needed to turn rows the
// database already counted into a tile.

export type NextDeadline =
  | { kind: 'due'; milestoneKey: string; name: string; dueOn: string; days: number }
  // MS1-7 happens at the Final Event and has no published window. A milestone
  // with no due_on renders TBC — an invented deadline is worse than a blank.
  | { kind: 'tbc' }

// SOURCE: milestones.due_on, current season, earliest date not yet passed.
// docs/now-metrics.sql §1
export function nextDeadline(milestones: Milestone[], today: Date): NextDeadline {
  const todayIso = today.toISOString().slice(0, 10)
  const upcoming = milestones
    .filter((m): m is Milestone & { due_on: string } => m.due_on !== null)
    .filter((m) => m.due_on >= todayIso)
    .sort((a, b) => a.due_on.localeCompare(b.due_on))[0]

  if (!upcoming) return { kind: 'tbc' }
  const days = Math.round(
    (Date.parse(`${upcoming.due_on}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) /
      86_400_000,
  )
  return {
    kind: 'due',
    milestoneKey: upcoming.key,
    name: upcoming.name,
    dueOn: upcoming.due_on,
    days,
  }
}

// SOURCE: v_subteam_progress (duties, resolved) where is_parked = false.
// The view decides what "resolved" means; this only adds the columns up.
// Parked = Race Operations, which only bites at the Final Event.
// docs/now-metrics.sql §2
export function liveObligations(rows: SubteamProgress[]): {
  resolved: number
  total: number
} {
  const live = rows.filter((r) => !r.is_parked)
  return {
    resolved: live.reduce((n, r) => n + (r.resolved ?? 0), 0),
    total: live.reduce((n, r) => n + (r.duties ?? 0), 0),
  }
}

// SOURCE: milestones.max_points for the current season, MS1 keys only.
// Totals 600 for the MS2627 edition; read from the data, never hard-coded, so
// a future edition with different points shows its own number.
// docs/now-metrics.sql §3
export function ms1Points(milestones: Milestone[]): number {
  return milestones
    .filter((m) => m.key.startsWith('MS1'))
    .reduce((n, m) => n + (m.max_points ?? 0), 0)
}

// SOURCE: v_attention where reason = 'overdue'. The view owns the definition.
// docs/now-metrics.sql §4
export function overdueCount(attention: Attention[]): number {
  return attention.filter((a) => a.reason === 'overdue').length
}

// SOURCE: topics.state = 'open', current season. docs/now-metrics.sql §5
export function openTopicsCount(topics: Topic[]): number {
  return topics.filter((t) => t.state === 'open').length
}

// SOURCE: v_attention where reason = 'blocked' — covers blocked rules AND
// blocked tasks in one place, again decided by SQL. docs/now-metrics.sql §6
export function blockedCount(attention: Attention[]): number {
  return attention.filter((a) => a.reason === 'blocked').length
}

export function percent(resolved: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((resolved / total) * 100)
}
