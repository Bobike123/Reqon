import { Link } from 'react-router-dom'
import type { Proposal } from '../../proposals/types.ts'
import { proposalStatusLabel } from '../../proposals/proposalStates.ts'
import { archiveLabel, completionLabel } from '../../tasks/lifecycle.ts'
import { TASK_PRIORITY_LABEL, isUrgent } from '../../tasks/priority.ts'
import { TASK_STATE_LABEL } from '../../tasks/taskState.ts'
import type { Task } from '../../tasks/types.ts'
import { formatDay, formatInstant } from '../../lib/dates.ts'
import type { SourceProposal, SourcedTask } from '../../data/useTaskHistory.ts'
import { buttonSecondary } from '../../ui/buttons.ts'
import { ActivityHistory } from './ActivityHistory.tsx'

function Missing({ children }: { children: string }) {
  return <span className="text-slate-500 italic">{children}</span>
}

const PROPOSAL_ARCHIVE_REASON: Record<string, string> = {
  promoted: 'Approved and turned into a task',
  promoted_legacy: 'Approved earlier, before outcomes were recorded',
  rejected: 'Rejected',
}

// One archived task. Read-only by design: an archived row is not edited until it
// has been explicitly restored, and reading it needs no write privilege. The
// restore control appears only for someone who may restore it.
export function ArchivedTaskRow({
  task,
  departmentName,
  ownerName,
  source,
  canRestore,
  restoring,
  onRestore,
  memberNames,
}: {
  task: Task
  departmentName: string | null
  ownerName: string | null
  source: SourceProposal | null
  canRestore: boolean
  restoring: boolean
  onRestore: (task: Task) => void
  memberNames: ReadonlyMap<string, string>
}) {
  const completed = completionLabel(task)
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3" data-testid={`archived-task-${task.id}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{task.title}</h3>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{TASK_STATE_LABEL[task.state]} when archived</span>
        {isUrgent(task.priority) && <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800">{TASK_PRIORITY_LABEL.urgent}</span>}
      </div>
      <p className="mt-1 text-xs text-slate-600">
        {departmentName ?? <Missing>No department</Missing>} · {ownerName ?? <Missing>Unassigned</Missing>} ·{' '}
        {task.due_date ? `due ${formatDay(task.due_date)}` : <Missing>no deadline</Missing>}
      </p>
      <p className="mt-1 text-xs text-slate-600" data-testid={`archived-when-${task.id}`}>
        {archiveLabel(task) ?? 'Archived'}
        {completed ? ` · ${completed}` : ''}
      </p>
      {source && (
        <p className="mt-1 text-xs text-slate-600" data-testid={`archived-source-${task.id}`}>
          Created from the proposal{' '}
          <Link className="font-medium underline underline-offset-2" to={`/archive?tab=proposals&id=${source.id}`}>
            “{source.title}”
          </Link>
        </p>
      )}
      {canRestore && (
        <div className="mt-2">
          <button type="button" className={buttonSecondary} disabled={restoring} onClick={() => onRestore(task)} data-testid={`restore-${task.id}`}>
            {restoring ? 'Restoring…' : 'Restore…'}
          </button>
        </div>
      )}
      <ActivityHistory entity="task" entityId={task.id} memberNames={memberNames} />
    </li>
  )
}

// One proposal that is no longer live, with its outcome and where it went.
export function HistoryProposalRow({
  proposal,
  departmentName,
  ownerName,
  task,
  memberNames,
}: {
  proposal: Proposal
  departmentName: string | null
  ownerName: string | null
  task: SourcedTask | null
  memberNames: ReadonlyMap<string, string>
}) {
  const when = proposal.archived_at ?? proposal.decided_at
  const reason = proposal.archive_reason ? PROPOSAL_ARCHIVE_REASON[proposal.archive_reason] : null
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3" data-testid={`history-proposal-${proposal.id}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{proposal.title}</h3>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700" data-testid={`history-status-${proposal.id}`}>
          {proposalStatusLabel(proposal)}
        </span>
      </div>
      {proposal.context && <p className="mt-0.5 text-sm text-slate-600">{proposal.context}</p>}
      <p className="mt-1 text-xs text-slate-600">
        {departmentName ?? <Missing>No department</Missing>} · proposed owner {ownerName ?? <Missing>none</Missing>} ·{' '}
        {proposal.due_date ? `due ${formatDay(proposal.due_date)}` : <Missing>no deadline</Missing>}
      </p>
      <p className="mt-1 text-xs text-slate-600">
        {reason ?? 'Decided'}
        {when ? ` · ${formatInstant(when)}` : ''}
      </p>
      {proposal.decision && <p className="mt-1 rounded bg-slate-50 p-2 text-sm text-slate-700"><span className="font-medium">Note:</span> {proposal.decision}</p>}
      {task && (
        <p className="mt-1 text-xs text-slate-600" data-testid={`history-task-${proposal.id}`}>
          Created the task{' '}
          <Link className="font-medium underline underline-offset-2" to={task.archived_at ? `/archive?id=${task.id}` : '/board'}>
            “{task.title}”
          </Link>
          {task.archived_at ? ' (now archived)' : ''}
        </p>
      )}
      <ActivityHistory entity="proposal" entityId={proposal.id} memberNames={memberNames} />
    </li>
  )
}
