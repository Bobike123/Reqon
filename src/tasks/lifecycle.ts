import { formatInstant } from '../lib/dates.ts'
import type { Task } from './types.ts'

// Presentation of the archive/completion lifecycle (ADR-0004). The database
// owns the actual transitions (guard_task_edit(), archive_task(),
// restore_task() — 20260116000000_task_lifecycle_and_authorization.sql);
// this module only decides how to SHOW the result.

export function isArchived(task: Pick<Task, 'archived_at'>): boolean {
  return task.archived_at !== null
}

export function isDone(task: Pick<Task, 'state'>): boolean {
  return task.state === 'done'
}

// completion_source distinguishes a real recorded transition from this
// migration's own best-effort reconstruction of legacy rows (ADR-0004) — the
// UI must never present a backfilled kind as an exact instant.
export function completionLabel(
  task: Pick<Task, 'completed_at' | 'completion_source'>,
): string | null {
  if (!task.completed_at) return null
  const when = formatInstant(task.completed_at)
  if (task.completion_source === 'migration_observed') {
    return `Completed before ${when} (exact time unknown)`
  }
  return `Completed ${when}`
}

const ARCHIVE_REASON_LABEL: Record<string, string> = {
  auto_done_24h: 'Archived automatically (done for 24h+)',
  manual: 'Archived manually',
}

export function archiveLabel(
  task: Pick<Task, 'archived_at' | 'archive_reason'>,
): string | null {
  if (!task.archived_at) return null
  const when = formatInstant(task.archived_at)
  const reason = task.archive_reason ? ARCHIVE_REASON_LABEL[task.archive_reason] : null
  return reason ? `${reason} · ${when}` : `Archived ${when}`
}

// A promoted task's deadline is protected server-side (guard_task_edit()) —
// mirrored here only so a Due-date field can be shown as read-only/explained
// rather than silently rejecting a clear attempt after the fact.
export function dueDateIsProtected(task: Pick<Task, 'source_proposal' | 'due_date'>): boolean {
  return task.source_proposal !== null && task.due_date !== null
}
