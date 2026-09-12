import { useId, useState } from 'react'
import type { Member } from '../data/useMembers.ts'
import { usePromoteProposal, type Proposal } from '../data/useProposals.ts'
import type { TaskState } from '../data/useTasks.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { ActionError } from '../ui/states.tsx'

// Promoting a proposal into a board task. The promoter decides the three things
// the proposal cannot know: who owns it, when it is due, and which lane it
// starts in.
//
// Only an administrator sees this, and only an administrator may do it —
// task_insert and proposal_update both call is_admin(). A member who forced the
// dialog open would have the insert refused by the database.

// Lanes a promotion can start in. Promoting straight into Done or Cancelled
// would record work that never happened, so they are not offered.
const START_LANES: { value: TaskState; label: string }[] = [
  { value: 'todo', label: 'To do' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'wip', label: 'In progress' },
]

export function PromoteDialog({
  proposal,
  members,
  onClose,
  onPromoted,
}: {
  proposal: Proposal | null
  members: Member[]
  onClose: () => void
  onPromoted: (message: string) => void
}) {
  const titleId = useId()
  const promote = usePromoteProposal()
  const close = () => {
    promote.reset()
    onClose()
  }

  return (
    <Dialog open={proposal !== null} onClose={close} labelledBy={titleId} dismissible={!promote.isPending}>
      {proposal && (
        <Form
          key={proposal.id}
          proposal={proposal}
          members={members}
          titleId={titleId}
          pending={promote.isPending}
          error={promote.error}
          onCancel={close}
          onSubmit={async (fields) => {
            try {
              const { created } = await promote.mutateAsync({ proposal, ...fields })
              promote.reset()
              onPromoted(
                created
                  ? `“${proposal.title}” is on the Board.`
                  : `“${proposal.title}” was already on the Board.`,
              )
            } catch {
              // Shown in the dialog by ActionError; nothing else changes.
            }
          }}
        />
      )}
    </Dialog>
  )
}

function Form({
  proposal,
  members,
  titleId,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  proposal: Proposal
  members: Member[]
  titleId: string
  pending: boolean
  error: Error | null
  onCancel: () => void
  onSubmit: (fields: { ownerId: string | null; dueDate: string | null; state: TaskState }) => void
}) {
  const [ownerId, setOwnerId] = useState(proposal.owner_id ?? '')
  // Empty on purpose. The club often does not know a date yet, and an invented
  // one is worse than none: the Board marks overdue from this field.
  const [dueDate, setDueDate] = useState('')
  const [state, setState] = useState<TaskState>('todo')
  const fieldId = (name: string) => `${titleId}-${name}`

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (pending) return
        onSubmit({ ownerId: ownerId || null, dueDate: dueDate || null, state })
      }}
    >
      <h2 id={titleId} className="text-base font-semibold text-balance text-slate-900">
        Promote to a board task
      </h2>
      <p className="mt-1 text-sm text-pretty text-slate-700">
        “{proposal.title}” becomes an official task. The proposal stays, marked decided, and the
        task remembers where it came from.
      </p>

      <fieldset className="mt-4 grid gap-3" disabled={pending}>
        <legend className="sr-only">Task details</legend>

        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor={fieldId('owner')}>
            Owner
          </label>
          <select
            id={fieldId('owner')}
            name="owner"
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          >
            <option value="">Nobody yet</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor={fieldId('due')}>
            Due date (optional)
          </label>
          <input
            id={fieldId('due')}
            name="due_date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          />
          <p className="mt-1 text-xs text-slate-500">Leave empty if the club has not fixed one.</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600" htmlFor={fieldId('lane')}>
            Starts in
          </label>
          <select
            id={fieldId('lane')}
            name="state"
            value={state}
            onChange={(e) => setState(e.target.value as TaskState)}
            className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          >
            {START_LANES.map((lane) => (
              <option key={lane.value} value={lane.value}>
                {lane.label}
              </option>
            ))}
          </select>
        </div>
      </fieldset>

      <ActionError error={error} className="mt-3" />

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" className={buttonSecondary} disabled={pending} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={buttonPrimary} disabled={pending}>
          {pending ? 'Promoting…' : 'Promote to task'}
        </button>
      </div>
    </form>
  )
}
