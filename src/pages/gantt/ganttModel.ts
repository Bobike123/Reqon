import type { Milestone, MilestoneSection } from '../../milestones/types.ts'
import { taskProgress, tasksInMilestone } from '../../tasks/progress.ts'
import type { Task } from '../../tasks/types.ts'
import { draftedCount } from '../milestones/milestoneModel.ts'
import { milestoneProgress } from './ganttProgress.ts'

// The arithmetic behind the Gantt: where a bar sits and how far along it is.
// Kept out of the screen so both can be tested without rendering a chart, and
// so nobody has to read JSX to find out how a percentage was arrived at.
//
// Everything here is a plain YYYY-MM-DD string. Those sort correctly as text,
// so the minimum and maximum of a set of dates need no Date objects at all —
// and no time zone can shift a bar by a day on someone else's laptop.

const DAY_MS = 86_400_000
const ISO_DAY = /^\d{4}-\d{2}-\d{2}/

export type Span = { from: string; to: string }
export type Box = { left: number; width: number }

export function isDay(value: string | null | undefined): value is string {
  return typeof value === 'string' && ISO_DAY.test(value)
}

// Whole days since the epoch. Only ever used for differences, never displayed.
function dayNumber(iso: string): number {
  return Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS)
}

function isoOfDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

// Day 0 of the following month is the last day of this one, and Date.UTC rolls
// December over into January of the next year on its own.
function monthEnd(iso: string): string {
  const [year, month] = iso.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

function nextMonth(iso: string): string {
  const [year, month] = iso.split('-').map(Number)
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10)
}

// The chart's horizontal extent, widened to whole months so the month ruler
// lines up with the bars underneath it. Today is always included: a chart whose
// "today" line sits off the edge tells you nothing about where you are.
export function timelineRange(dates: (string | null | undefined)[], today: string): Span {
  const days = [today, ...dates.filter(isDay)].map((d) => d.slice(0, 10))
  const first = days.reduce((a, b) => (b < a ? b : a))
  const last = days.reduce((a, b) => (b > a ? b : a))
  return { from: monthStart(first), to: monthEnd(last) }
}

// Where a span sits in the track, as CSS percentages. Both ends are inclusive,
// so a task due on one single day still gets a visible sliver instead of a bar
// of zero width. Returns null for a span entirely outside the chart.
export function placeBar(span: Span, range: Span): Box | null {
  const from = span.from <= span.to ? span.from : span.to
  const to = span.from <= span.to ? span.to : span.from
  if (to < range.from || from > range.to) return null

  const start = from < range.from ? range.from : from
  const end = to > range.to ? range.to : to
  const total = dayNumber(range.to) - dayNumber(range.from) + 1
  return {
    left: ((dayNumber(start) - dayNumber(range.from)) / total) * 100,
    width: ((dayNumber(end) - dayNumber(start) + 1) / total) * 100,
  }
}

// Whole days the chart spans, both ends inclusive — the unit a dragged bar's
// pixel distance is converted into.
export function rangeDays(range: Span): number {
  return dayNumber(range.to) - dayNumber(range.from) + 1
}

// A calendar day moved by whole days. Pure string arithmetic in UTC, so no
// time zone can shift a dragged deadline by one.
export function shiftDay(iso: string, days: number): string {
  return isoOfDay(dayNumber(iso) + days)
}

// Where a single date sits, as a percentage — for the "today" line.
export function placeDay(iso: string, range: Span): number | null {
  const box = placeBar({ from: iso, to: iso }, range)
  return box ? box.left : null
}

export type Tick = Box & { key: string; label: string }

// One label per month across the range. Capped so a nonsense range (a date
// typed as the year 9999) cannot spin here forever.
export function monthTicks(range: Span): Tick[] {
  const ticks: Tick[] = []
  let month = monthStart(range.from)
  for (let guard = 0; guard < 600 && month <= range.to; guard += 1) {
    const end = monthEnd(month)
    const box = placeBar({ from: month, to: end < range.to ? end : range.to }, range)
    if (box) {
      ticks.push({
        ...box,
        key: month.slice(0, 7),
        label: new Date(`${month}T00:00:00Z`).toLocaleDateString('en-GB', {
          month: 'short',
          year: '2-digit',
          timeZone: 'UTC',
        }),
      })
    }
    month = nextMonth(month)
  }
  return ticks
}

// One label per week, from the Monday on or before the range's start. The first
// and last ticks are clipped by placeBar, so a range that does not begin on a
// Monday still gets a correctly sized partial column.
export function weekTicks(range: Span): Tick[] {
  const ticks: Tick[] = []
  const start = dayNumber(range.from)
  // Thursday 1970-01-01 is day 0, so Monday is day % 7 === 4.
  let day = start - ((start - 4) % 7 + 7) % 7
  const end = dayNumber(range.to)
  for (let guard = 0; guard < 600 && day <= end; guard += 1) {
    const from = isoOfDay(day)
    const box = placeBar({ from, to: isoOfDay(day + 6) }, range)
    if (box) {
      ticks.push({
        ...box,
        key: from,
        label: new Date(`${from}T00:00:00Z`).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        }),
      })
    }
    day += 7
  }
  return ticks
}

// The one progress rule (tasks/progress.ts, ADR-0006) — kept under this
// file's existing name so MilestoneRow.tsx/SectionRow.tsx (and the rest of
// this file) need no change. A cancelled task leaves the count entirely;
// percent is null, not 0, when there is nothing to count: "no subtasks yet"
// and "no subtask finished yet" are different facts and the screen says so.
export type { Progress } from '../../tasks/progress.ts'
export const progressOf = taskProgress

export function tasksInSection(tasks: Task[], sectionId: string): Task[] {
  return tasks.filter((t) => t.section_id === sectionId)
}

// Subtasks decide a section's progress. With none, it falls back to the drafted
// tick the section has always had on the Milestones screen, so a team that has
// not started using subtasks sees exactly what it saw before.
export function sectionPercent(section: MilestoneSection, tasks: Task[]): number {
  return progressOf(tasksInSection(tasks, section.id)).percent ?? (section.is_drafted ? 100 : 0)
}

// Same rule one level up: every subtask under the milestone, or its sections
// drafted out of total when there are none.
type ProgressSource = Pick<Task, 'id' | 'state' | 'archived_at' | 'section_id' | 'milestone_key'>

// `tasks` here is the PROGRESS list (active and archived), so an archived Done
// task still counts as complete and an archived unfinished one stays in the
// denominator (ADR-0006) — unlike the active list a row's own bar is drawn from.
export function milestonePercent(sections: MilestoneSection[], tasks: ProgressSource[], milestoneKey?: string): number {
  // With a milestone key this IS ganttProgress.milestoneProgress (the one rule);
  // the number alone is kept for callers that only want a percentage.
  if (milestoneKey !== undefined) return milestoneProgress(sections, tasks, milestoneKey).percent ?? 0
  const ids = new Set(sections.map((s) => s.id))
  // With the milestone's key, unsectioned tasks attached to it count too (each
  // task once); without it, only sectioned tasks, as before.
  const mine =
    milestoneKey === undefined
      ? tasks.filter((t) => t.section_id !== null && ids.has(t.section_id))
      : tasksInMilestone(tasks, milestoneKey, ids)
  const percent = progressOf(mine).percent
  if (percent !== null) return percent
  const { drafted, total } = draftedCount(sections)
  return total === 0 ? 0 : Math.round((drafted / total) * 100)
}

// A milestone's own bar: the published submission window. Null means TBC, which
// the screen prints as TBC rather than inventing a date to draw.
export function milestoneSpan(milestone: Milestone): Span | null {
  if (!isDay(milestone.due_on)) return null
  return {
    from: isDay(milestone.opens_on) ? milestone.opens_on : milestone.due_on,
    to: milestone.due_on,
  }
}

// The earliest and latest of a set of dates, ignoring the missing ones.
export function spanOfDates(dates: (string | null | undefined)[]): Span | null {
  const days = dates.filter(isDay).map((d) => d.slice(0, 10)).sort()
  return days.length === 0 ? null : { from: days[0], to: days[days.length - 1] }
}

// A section has no dates of its own. Its subtasks' due dates give it one; with
// none, it borrows the milestone's window, which is the honest answer —
// "somewhere inside this submission".
// Starts count as well as deadlines, so a section whose subtasks begin early is
// drawn from that start, not from the first deadline.
export function sectionSpan(tasks: Task[], sectionId: string, fallback: Span | null): Span | null {
  return spanOfDates(tasksInSection(tasks, sectionId).flatMap((t) => [t.starts_on, t.due_date])) ?? fallback
}
