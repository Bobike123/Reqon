import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatDay } from '../../lib/dates.ts'
import { isUrgent, TASK_PRIORITY_BADGE_TONE, TASK_PRIORITY_LABEL } from '../../tasks/priority.ts'
import { TASK_STATES, TASK_STATE_LABEL } from '../../tasks/taskState.ts'
import type { Task, TaskState } from '../../tasks/types.ts'
import { isOverdue } from './boardModel.ts'
import { TaskDetails, type TaskPermissions } from './TaskDetails.tsx'

type Props = {
  task: Task
  departmentName: string | null
  ownerName: string | null
  milestoneLabel: string | null
  requirementKeys: string[]
  source: { id: string; title: string } | null
  perms: TaskPermissions
  owners: { id: string; name: string }[]
  milestones: { value: string; label: string }[]
  moving: boolean
  today: string
  onMove: (id: string, state: TaskState) => void
  tutorial: boolean
  // Arrived by a link naming this task: open its details and bring it into view.
  focused?: boolean
}

// A missing (legacy) value is shown as missing, in muted italics, never filled
// in with something plausible.
function Missing({ children }: { children: string }) {
  return <span className="text-slate-500 italic">{children}</span>
}

// One compact card: title, priority badge, department, owner, deadline,
// milestone, requirement count and workflow state; longer text and the editor
// live under Details. Movement is a <select> (no drag and drop: unusable by
// keyboard, awkward on a phone), offered only to someone who may move the task.
export function TaskCard(props: Props) {
  const { task, perms } = props
  const [open, setOpen] = useState(Boolean(props.focused))
  const cardRef = useRef<HTMLLIElement>(null)
  const focused = Boolean(props.focused)
  useEffect(() => {
    if (!focused) return
    cardRef.current?.scrollIntoView?.({ block: 'center' })
    cardRef.current?.focus({ preventScroll: true })
  }, [focused])
  const overdue = isOverdue(task, props.today)
  const reqCount = props.requirementKeys.length

  return (
    <li
      ref={cardRef}
      tabIndex={focused ? -1 : undefined}
      className={`rounded border bg-white p-2 ${focused ? 'border-slate-900 ring-2 ring-slate-400' : 'border-slate-200'}`}
      data-testid={`task-${task.id}`}
      data-task-state={task.state}
      data-source-proposal={task.source_proposal ?? ''}
      data-tutorial={props.tutorial ? 'board-card' : undefined}
    >
      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-slate-900">
        {task.title}
        {isUrgent(task.priority) && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase ${TASK_PRIORITY_BADGE_TONE.urgent}`}>
            {TASK_PRIORITY_LABEL.urgent}
          </span>
        )}
      </p>

      <dl className="mt-1 space-y-0.5 text-xs text-slate-700" data-testid={`task-facts-${task.id}`}>
        <div className="flex flex-wrap gap-x-2">
          <dt className="sr-only">Owner</dt>
          <dd className="font-medium">{props.ownerName ?? <Missing>Unassigned</Missing>}</dd>
          <dt className="sr-only">Department</dt>
          <dd className="min-w-0 truncate">{props.departmentName ?? <Missing>No department</Missing>}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="sr-only">Deadline</dt>
          <dd className={overdue ? 'font-semibold text-red-700' : undefined}>
            {task.due_date ? `${overdue ? '! ' : ''}Due ${formatDay(task.due_date)}${overdue ? ' · overdue' : ''}` : <Missing>No deadline</Missing>}
          </dd>
          <dt className="sr-only">State</dt>
          <dd className="text-slate-600">{TASK_STATE_LABEL[task.state]}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2 text-[11px] text-slate-600">
          <dt className="sr-only">Milestone</dt>
          <dd>{props.milestoneLabel ?? <Missing>No milestone</Missing>}</dd>
          <dt className="sr-only">Requirements</dt>
          <dd data-testid={`task-reqs-${task.id}`}>
            {reqCount > 0 ? `${reqCount} ${reqCount === 1 ? 'requirement' : 'requirements'}` : <Missing>No requirements linked</Missing>}
          </dd>
        </div>
      </dl>

      {/* The blocker is its own line, apart from the description. Reqon records
          only the Blocked state, so the summary says a reason is missing rather
          than inventing one. */}
      {task.state === 'blocked' && (
        <p className="mt-1 rounded border-l-4 border-amber-500 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-950" data-testid={`task-blocked-${task.id}`}>
          <span className="font-semibold">Blocked</span> · no reason recorded
        </p>
      )}

      {props.source && (
        <p className="mt-1 text-[11px] text-slate-500" data-testid={`task-origin-${task.id}`}>
          From proposal:{' '}
          <Link to={`/archive?tab=proposals&id=${props.source.id}`} className="underline underline-offset-2">
            “{props.source.title}”
          </Link>
        </p>
      )}

      {perms.canEdit && (
        <div className="mt-2">
          <label className="sr-only" htmlFor={`task-state-${task.id}`}>
            Move {task.title} to another lane
          </label>
          <select
            id={`task-state-${task.id}`}
            value={task.state}
            disabled={props.moving}
            onChange={(e) => props.onMove(task.id, e.target.value as TaskState)}
            className="min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
          >
            {TASK_STATES.map((l) => (
              <option key={l.state} value={l.state}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <details
        className="mt-2"
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        data-testid={`task-more-${task.id}`}
      >
        <summary className="inline-flex min-h-11 cursor-pointer items-center rounded text-xs font-medium text-slate-700 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:outline-none sm:min-h-0">
          {perms.canEdit ? 'Details and edit' : 'Details'}
        </summary>
        {open && (
          <TaskDetails
            task={task}
            perms={perms}
            owners={props.owners}
            milestones={props.milestones}
            requirementKeys={props.requirementKeys}
            source={props.source}
          />
        )}
      </details>
    </li>
  )
}
