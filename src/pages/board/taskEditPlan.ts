import type { TaskEdit } from '../../data/useTasks.ts'
import type { Task, TaskPriority } from '../../tasks/types.ts'

// Turns what someone typed into the ONE task edit command, or says why it
// cannot be sent. Pure, so every rule here is tested without rendering.
//
// Only fields that actually changed are sent. An emptied field is sent as a
// real "clear" (null), never silently dropped — dropping it and then saying
// "Saved" was finding F14-04. What the database will refuse anyway (a promoted
// task's deadline, a start after the deadline) is refused here first with the
// same meaning, so the person is told before anything is written.

export type TaskFormValues = {
  title: string
  detail: string
  start: string // YYYY-MM-DD or ''
  due: string // YYYY-MM-DD or ''
  priority: TaskPriority
  // '' keeps the current milestone (the select has no "remove" choice here;
  // the Gantt's Unlink is the place for that).
  milestone: string
  owner: string // '' = unassigned
  // Only meaningful while the task is Blocked; '' otherwise.
  blockedReason: string
}

export type EditPlan =
  | { kind: 'edit'; edit: TaskEdit; changed: string[] }
  | { kind: 'unchanged' }
  | { kind: 'invalid'; reason: string }

type Editable = Pick<
  Task,
  'id' | 'title' | 'detail' | 'starts_on' | 'due_date' | 'priority' | 'milestone_key' | 'owner_id' | 'links_required' | 'state' | 'blocked_reason'
> & Partial<Pick<Task, 'source_proposal' | 'section_id'>>

const MAX_TITLE = 200
export const MAX_BLOCKER_REASON = 500

export function planTaskEdit(
  task: Editable,
  values: TaskFormValues,
  canReassign: boolean,
  // Whether the task has at least one prerequisite task, which explains a
  // blocker on its own so the written reason may then be left empty.
  context: { hasPrerequisites?: boolean } = {},
): EditPlan {
  const edit: TaskEdit = { id: task.id }
  const changed: string[] = []

  const title = values.title.trim()
  if (title !== task.title) {
    if (title.length === 0) return { kind: 'invalid', reason: 'A task needs a title.' }
    if (title.length > MAX_TITLE) return { kind: 'invalid', reason: `A title can be at most ${MAX_TITLE} characters.` }
    edit.title = title
    changed.push('title')
  }

  const detail = values.detail.trim() === '' ? null : values.detail
  if ((detail ?? '') !== (task.detail ?? '')) {
    edit.detail = detail === null ? null : detail.trim()
    changed.push(detail === null ? 'description cleared' : 'description')
  }

  const schedule = planScheduleEdit(task, values.start || null, values.due || null)
  if (schedule.kind === 'invalid') return schedule
  if (schedule.kind === 'edit') {
    Object.assign(edit, schedule.edit)
    changed.push(...schedule.changed)
  }

  if (task.state === 'blocked') {
    const reason = values.blockedReason.trim()
    if (reason !== (task.blocked_reason ?? '')) {
      if (reason.length > MAX_BLOCKER_REASON) {
        return { kind: 'invalid', reason: `A blocker reason can be at most ${MAX_BLOCKER_REASON} characters.` }
      }
      if (reason === '' && !context.hasPrerequisites) {
        return { kind: 'invalid', reason: 'A blocked task must say why. Write the reason, link the task it is waiting for, or move it out of Blocked.' }
      }
      edit.blockedReason = reason === '' ? null : reason
      changed.push(reason === '' ? 'blocker reason removed' : 'blocker reason')
    }
  }

  if (values.priority !== task.priority) {
    edit.priority = values.priority
    changed.push('priority')
  }
  if (values.milestone !== '' && values.milestone !== task.milestone_key) {
    edit.milestoneKey = values.milestone
    // A section belongs to one milestone, and the database refuses a task whose section and milestone
    // disagree. Moving to another milestone therefore takes the task out of its section in the same
    // write (it can be placed in one of the new milestone's sections on the Gantt), and says so.
    if (task.section_id) {
      edit.sectionId = null
      changed.push('milestone (left its section)')
    } else {
      changed.push('milestone')
    }
  }
  if (canReassign && values.owner !== (task.owner_id ?? '')) {
    edit.ownerId = values.owner || null
    changed.push('owner')
  }

  return changed.length === 0 ? { kind: 'unchanged' } : { kind: 'edit', edit, changed }
}

// A schedule change — from the editor, the timeline's date fields or a dragged
// bar: the two date fields only, under the same rules the database enforces
// (starts_on <= due_date; a promoted task keeps a deadline).
export function planScheduleEdit(
  task: Pick<Task, 'id' | 'starts_on' | 'due_date' | 'links_required'> & Partial<Pick<Task, 'source_proposal'>>,
  start: string | null,
  due: string | null,
): EditPlan {
  const edit: TaskEdit = { id: task.id }
  const changed: string[] = []
  if (due !== task.due_date) {
    // The database keeps a deadline on any task that came from a proposal
    // (source_proposal), and on one it still requires links for; say so first.
    if (due === null && (task.links_required || Boolean(task.source_proposal)) && task.due_date !== null) {
      return { kind: 'invalid', reason: 'A task created from a proposal must keep a deadline. Change the date instead of removing it.' }
    }
    edit.dueDate = due
    changed.push(due === null ? 'deadline removed' : 'deadline')
  }
  if (start !== task.starts_on) {
    edit.startsOn = start
    changed.push(start === null ? 'start date removed' : 'start date')
  }
  if (start && due && start > due) return { kind: 'invalid', reason: 'The start date must be on or before the deadline.' }
  return changed.length === 0 ? { kind: 'unchanged' } : { kind: 'edit', edit, changed }
}
