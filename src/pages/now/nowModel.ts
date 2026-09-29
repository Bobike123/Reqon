import type { Milestone } from '../../milestones/types.ts'
import type { Attention, SubteamProgress } from '../../metrics/types.ts'
import type { Proposal } from '../../proposals/types.ts'
import { toLocalDateString } from '../../lib/dates.ts'
import { isOverdue } from '../../tasks/overdue.ts'
import { taskProgress, type Progress } from '../../tasks/progress.ts'
import type { Task } from '../../tasks/types.ts'

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
  const todayIso = toLocalDateString(today)
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

// SOURCE: attention(p_season, p_today) where reason = 'overdue'. SQL owns the
// definition, against the reader's own day; archived tasks never appear.
// docs/now-metrics.sql §4
export function overdueCount(attention: Attention[]): number {
  return attention.filter((a) => a.reason === 'overdue').length
}

// SOURCE: task_proposals awaiting a decision — suggested or under review, not
// archived — in the current season. Parked work is set aside and decided work is
// history, so neither counts. docs/now-metrics.sql §5
export function openProposalsCount(proposals: Proposal[]): number {
  return proposals.filter((p) => (p.state === 'open' || p.state === 'agenda') && p.archived_at === null).length
}

// SOURCE: attention(p_season, p_today) where reason = 'blocked' — covers blocked rules AND
// blocked tasks in one place, again decided by SQL. docs/now-metrics.sql §6
export function blockedCount(attention: Attention[]): number {
  return attention.filter((a) => a.reason === 'blocked').length
}

export function percent(resolved: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((resolved / total) * 100)
}

// ------------------------------------------------------- department overview
// One row per ACTIVE department, in its configured order, with two separate
// measures that must never be merged:
//   work         — the one task progress rule (tasks/progress.ts): distinct
//                  tasks of the department, cancelled excluded, archived Done
//                  counted, archived unfinished kept and reported.
//   requirements — requirement compliance from v_subteam_progress: rules the
//                  department owns that are marked compliant, verified or not
//                  applicable, out of its team duties. A status decision, never
//                  derived from task completion.
// An archived department is left out even though the view still lists it
// (finding F14-10).
type DepartmentLike = { key: string; name: string; is_parked: boolean; archived_at: string | null; sort_order: number; lead_id: string | null }
type ProgressTaskLike = Pick<Task, 'id' | 'state' | 'archived_at' | 'subteam_key'>
type ActiveTaskLike = Pick<Task, 'state' | 'archived_at' | 'subteam_key' | 'due_date'>

export type DepartmentOverview = {
  key: string
  name: string
  parked: boolean
  hasHead: boolean
  work: Progress
  open: { todo: number; wip: number; blocked: number }
  overdue: number
  requirements: { resolved: number; duties: number; blockedRules: number } | null
}

export function departmentOverview(
  departments: readonly DepartmentLike[],
  // Active AND archived tasks: what completion is counted from.
  progressTasks: readonly ProgressTaskLike[],
  // The active Board list: what is open or overdue now.
  activeTasks: readonly ActiveTaskLike[],
  compliance: readonly SubteamProgress[],
  today: string,
): DepartmentOverview[] {
  const complianceByKey = new Map(compliance.map((row) => [row.key, row]))
  return departments
    .filter((d) => d.archived_at === null)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    .map((d) => {
      const mine = progressTasks.filter((t) => t.subteam_key === d.key)
      const active = activeTasks.filter((t) => t.subteam_key === d.key && t.archived_at === null)
      const row = complianceByKey.get(d.key)
      return {
        key: d.key,
        name: d.name,
        parked: d.is_parked,
        hasHead: d.lead_id !== null,
        work: taskProgress(mine),
        open: {
          todo: active.filter((t) => t.state === 'todo').length,
          wip: active.filter((t) => t.state === 'wip').length,
          blocked: active.filter((t) => t.state === 'blocked').length,
        },
        overdue: active.filter((t) => isOverdue(t, today)).length,
        requirements: row ? { resolved: row.resolved ?? 0, duties: row.duties ?? 0, blockedRules: row.blocked ?? 0 } : null,
      }
    })
}

// Active, unfinished tasks due from today up to `days` ahead, soonest first.
// Overdue work is listed separately, so it is not repeated here.
export function upcomingDeadlines<T extends Pick<Task, 'due_date' | 'state' | 'archived_at'>>(tasks: readonly T[], today: string, days: number): T[] {
  const until = addDays(today, days)
  return tasks
    .filter((t) => t.archived_at === null && t.state !== 'done' && t.state !== 'cancelled')
    .filter((t): t is T & { due_date: string } => t.due_date !== null && t.due_date >= today && t.due_date <= until)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
}

// The viewer's own unfinished, active tasks: overdue first, then by deadline,
// undated last.
export function myOpenTasks<T extends Pick<Task, 'owner_id' | 'due_date' | 'state' | 'archived_at'>>(tasks: readonly T[], myId: string | null): T[] {
  if (!myId) return []
  return tasks
    .filter((t) => t.owner_id === myId && t.archived_at === null && t.state !== 'done' && t.state !== 'cancelled')
    .sort((a, b) => (a.due_date ?? '9999-12-31').localeCompare(b.due_date ?? '9999-12-31'))
}

// Task rows of the attention list for one reason, in the SQL's own terms.
export function attentionFor(attention: readonly Attention[], reason: string): Attention[] {
  return attention.filter((a) => a.reason === reason)
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
