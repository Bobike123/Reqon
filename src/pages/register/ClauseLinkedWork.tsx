import { useContext, useId, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ClauseState } from '../../clauses/types.ts'
import { TASK_PRIORITY_BADGE_TONE, TASK_PRIORITY_LABEL, isUrgent } from '../../tasks/priority.ts'
import { TASK_STATE_LABEL } from '../../tasks/taskState.ts'
import {
  offersMarkCompliant,
  progressDetail,
  progressHeadline,
  taskHref,
  type LinkedWork,
} from './linkedWork.ts'
import { AssignContext } from './assignContext.ts'
import { AssignTasks, type AssignCandidate } from './AssignTasks.tsx'

type Props = {
  clauseKey: string
  printedRef: string
  state: ClauseState
  work: LinkedWork
  // Whether the link and task lists have arrived. While they have not, or if
  // they failed, "No linked work" would be a false statement, so say so instead.
  availability: 'ready' | 'loading' | 'unavailable'
  // Id -> display name, shared across rows so this component stays cheap.
  memberNames: ReadonlyMap<string, string>
  departmentNames: ReadonlyMap<string, string>
  onMarkCompliant: (clauseKey: string) => void
}

// Compact, per-requirement view of the work linked to it, and the way to link
// existing Board tasks to it (AssignTasks). Tasks are never created from here,
// and there is no tree — a flat list of the tasks that address this rule.
export function ClauseLinkedWork({ clauseKey, printedRef, state, work, availability, memberNames, departmentNames, onMarkCompliant }: Props) {
  const [open, setOpen] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const assign = useContext(AssignContext)
  const linked = useMemo(() => new Map<string, AssignCandidate>(work.tasks.map((t) => [t.id, t])), [work.tasks])
  const listId = useId()
  const detail = progressDetail(work)
  const { progress } = work
  const offer = offersMarkCompliant(state, work)

  if (availability !== 'ready') {
    return (
      <p className="mt-2 text-xs text-slate-600" data-testid={`linked-work-${clauseKey}`}>
        {availability === 'loading' ? 'Loading linked work…' : 'Linked work could not be loaded.'}
      </p>
    )
  }

  return (
    <div className="mt-2 text-sm" data-testid={`linked-work-${clauseKey}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-slate-800" data-testid="link-progress">
          {progressHeadline(progress)}
        </span>
        {progress.total > 0 && (
          <span aria-hidden="true" className="h-1.5 w-20 overflow-hidden rounded bg-slate-200">
            <span className="block h-full bg-emerald-600" style={{ width: `${progress.percent ?? 0}%` }} />
          </span>
        )}
        {detail && (
          <span className="text-xs text-slate-600" data-testid="link-detail">
            {detail}
          </span>
        )}
        {work.tasks.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((value) => !value)}
            className="min-h-11 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-800 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          >
            {open ? 'Hide tasks' : `Show tasks (${work.tasks.length})`}
            <span className="sr-only"> for {printedRef}</span>
          </button>
        )}
        {assign && (
          <button
            type="button"
            aria-expanded={assigning}
            onClick={() => setAssigning((value) => !value)}
            className="min-h-11 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-800 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            data-testid={`assign-open-${clauseKey}`}
          >
            Assign existing tasks
            <span className="sr-only"> to {printedRef}</span>
          </button>
        )}
        {offer && (
          <button
            type="button"
            onClick={() => onMarkCompliant(clauseKey)}
            className="min-h-11 rounded border border-emerald-700 bg-white px-2 py-0.5 text-xs font-medium text-emerald-900 hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          >
            Mark compliant
            <span className="sr-only"> {printedRef}</span>
          </button>
        )}
      </div>
      {offer && (
        <p className="mt-0.5 text-xs text-slate-600">
          Every linked task is done. That does not make the rule compliant by itself, and marking it
          compliant does not verify it.
        </p>
      )}

      {assigning && assign && (
        <AssignTasks
          clauseKey={clauseKey}
          printedRef={printedRef}
          linked={linked}
          candidates={assign.candidates}
          canEdit={assign.canEdit}
          memberNames={memberNames}
          departmentNames={departmentNames}
          onClose={() => setAssigning(false)}
        />
      )}

      {open && (
        <ul id={listId} className="mt-1.5 divide-y divide-slate-100 rounded border border-slate-200 bg-white" data-testid="linked-tasks">
          {work.tasks.map((task) => (
            <li key={task.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2 py-1.5" data-task-id={task.id}>
              <Link
                to={taskHref(task)}
                className="min-h-11 py-2 font-medium text-slate-900 underline decoration-slate-400 underline-offset-2 hover:decoration-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0 sm:py-0"
              >
                {task.title}
              </Link>
              <span className="text-xs text-slate-700">{TASK_STATE_LABEL[task.state]}</span>
              {isUrgent(task.priority) && (
                <span className={`rounded px-1 py-0.5 text-[10px] font-bold ${TASK_PRIORITY_BADGE_TONE[task.priority]}`}>
                  {TASK_PRIORITY_LABEL[task.priority]}
                </span>
              )}
              {task.archived_at && (
                <span className="rounded bg-slate-200 px-1 py-0.5 text-[10px] font-medium text-slate-700">
                  {task.state === 'done' ? 'Archived, done' : 'Archived, not finished'}
                </span>
              )}
              {task.state === 'cancelled' && <span className="text-xs text-slate-500">not counted</span>}
              <span className="text-xs text-slate-600">
                {task.owner_id ? (memberNames.get(task.owner_id) ?? 'Unknown member') : 'Unassigned'}
                {' · '}
                {task.subteam_key ? (departmentNames.get(task.subteam_key) ?? task.subteam_key) : 'No department'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
