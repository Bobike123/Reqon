import type { Task } from './types.ts'

// A task is overdue only while it is still open work — done or cancelled keeps
// its due date on screen, but it is never "late" for something that is over.
// `today` is a caller-supplied YYYY-MM-DD (lib/dates.ts todayIso), never
// computed in here, so this stays deterministic in tests.
//
// The ONE definition: the Board, the Gantt and (through attention()'s SQL, which
// says `due_date < p_today` for open tasks) Now and Priorities all mean exactly
// this, compared as calendar-day strings so no time zone can move the boundary.
export function isOverdue(task: Pick<Task, 'due_date' | 'state'>, today: string): boolean {
  return (
    task.due_date !== null &&
    task.due_date < today &&
    task.state !== 'done' &&
    task.state !== 'cancelled'
  )
}
