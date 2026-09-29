import type { Milestone } from '../../milestones/types.ts'
import { formatDay } from '../../lib/dates.ts'
import { isOverdue } from '../../tasks/overdue.ts'
import { TASK_STATE_LABEL } from '../../tasks/taskState.ts'
import type { Task } from '../../tasks/types.ts'
import { isDay, type Span } from './ganttModel.ts'

// What each task and milestone DRAWS as, decided here in plain data so the
// chart components only place shapes and the tests can pin every case without
// rendering anything. Every mark also has a sentence (…Summary) that is the same
// fact in words, so nothing on the chart is colour-only or chart-only.
//
// All dates are YYYY-MM-DD strings compared as text; today is passed in.

type TaskDates = Pick<Task, 'starts_on' | 'due_date' | 'state'>

export type TaskMark =
  // Both dates: a period from starts_on to due_date.
  | { kind: 'period'; span: Span; overdue: boolean; done: boolean }
  // A deadline and no start: a marker on that day. No start date is invented.
  | { kind: 'deadline'; day: string; overdue: boolean; done: boolean }
  // A start and no deadline: a marker on the start, and the row says there is no deadline.
  | { kind: 'start-only'; day: string; done: boolean }
  // Neither: nothing is drawn, and the row says it is undated.
  | { kind: 'undated'; done: boolean }

export function taskMark(task: TaskDates, today: string): TaskMark {
  const done = task.state === 'done'
  const overdue = isOverdue({ due_date: isDay(task.due_date) ? task.due_date : null, state: task.state }, today)
  const start = isDay(task.starts_on) ? task.starts_on.slice(0, 10) : null
  const due = isDay(task.due_date) ? task.due_date.slice(0, 10) : null

  if (start && due) {
    // The database refuses starts_on > due_date; if a bad row ever appears the
    // bar is still drawn between the two, never dropped.
    const span = start <= due ? { from: start, to: due } : { from: due, to: start }
    return { kind: 'period', span, overdue, done }
  }
  if (due) return { kind: 'deadline', day: due, overdue, done }
  if (start) return { kind: 'start-only', day: start, done }
  return { kind: 'undated', done }
}

export function taskSummary(task: TaskDates & Pick<Task, 'title'>, today: string): string {
  const mark = taskMark(task, today)
  const state = TASK_STATE_LABEL[task.state]
  const late = 'overdue' in mark && mark.overdue ? ', overdue' : ''
  switch (mark.kind) {
    case 'period':
      return `${task.title}: ${formatDay(mark.span.from)} to ${formatDay(mark.span.to)}, ${state}${late}`
    case 'deadline':
      return `${task.title}: deadline ${formatDay(mark.day)} (no start date), ${state}${late}`
    case 'start-only':
      return `${task.title}: starts ${formatDay(mark.day)} (no deadline), ${state}`
    case 'undated':
      return `${task.title}: no dates set, ${state}`
  }
}

export type MilestoneMarks = {
  // The published submission window. Only when BOTH ends are known: with no
  // opens_on there is no window, and none is invented from the deadline.
  window: Span | null
  // The hard deadline, when there is one.
  deadline: string | null
  // An opening date with no deadline yet: shown as text, never as a bar.
  opensOnly: string | null
  // The deadline has passed (compared with today as a calendar day).
  passed: boolean
}

export function milestoneMarks(milestone: Pick<Milestone, 'opens_on' | 'due_on'>, today: string): MilestoneMarks {
  const opens = isDay(milestone.opens_on) ? milestone.opens_on.slice(0, 10) : null
  const due = isDay(milestone.due_on) ? milestone.due_on.slice(0, 10) : null
  return {
    window: opens && due ? (opens <= due ? { from: opens, to: due } : { from: due, to: opens }) : null,
    deadline: due,
    opensOnly: opens && !due ? opens : null,
    passed: due !== null && due < today,
  }
}

export function milestoneSummary(
  milestone: Pick<Milestone, 'key' | 'name' | 'opens_on' | 'due_on'>,
  today: string,
  progress: string,
): string {
  const marks = milestoneMarks(milestone, today)
  const head = `${milestone.key} ${milestone.name}`
  if (marks.deadline === null) {
    const opens = marks.opensOnly ? `opens ${formatDay(marks.opensOnly)}, ` : ''
    return `${head}: ${opens}deadline TBC (not yet published), ${progress}`
  }
  const window = marks.window ? `submission window ${formatDay(marks.window.from)} to ${formatDay(marks.window.to)}, ` : 'no opening date published, '
  return `${head}: ${window}deadline ${formatDay(marks.deadline)}${marks.passed ? ' (passed)' : ''}, ${progress}`
}

// Every date the chart must fit: task starts AND ends, milestone window ends and
// deadlines. Starts are included so a period that begins before every deadline
// is never clipped off the left edge (ganttModel.timelineRange widens to whole
// months and always includes today).
export function planningDates(
  milestones: readonly Pick<Milestone, 'opens_on' | 'due_on'>[],
  tasks: readonly Pick<Task, 'starts_on' | 'due_date'>[],
): (string | null)[] {
  return [
    ...milestones.flatMap((m) => [m.opens_on, m.due_on]),
    ...tasks.flatMap((t) => [t.starts_on, t.due_date]),
  ]
}
