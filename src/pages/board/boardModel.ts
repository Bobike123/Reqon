import type { Task } from '../../tasks/types.ts'

// A task is overdue only while it is still open work — done or cancelled
// keeps its due date on screen, but it is never "late" for something over.
// `today` is a caller-supplied YYYY-MM-DD (see lib/dates.ts toLocalDateString
// / todayIso), never computed in here, so this stays deterministic in tests.
export function isOverdue(task: Pick<Task, 'due_date' | 'state'>, today: string): boolean {
  return (
    task.due_date !== null &&
    task.due_date < today &&
    task.state !== 'done' &&
    task.state !== 'cancelled'
  )
}
