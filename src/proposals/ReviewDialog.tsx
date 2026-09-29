import { useId, useRef, useState } from 'react'
import type { Member } from '../data/useMembers.ts'
import {
  useReviewProposal,
  usePromoteProposal,
  useSetProposalRequirements,
  useUpdateProposal,
  type Proposal,
  type ProposalEdit,
} from '../data/useProposals.ts'
import { TASK_PRIORITIES, TASK_PRIORITY_LABEL } from '../tasks/priority.ts'
import type { TaskPriority } from '../tasks/types.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { buttonDanger, buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { ActionError } from '../ui/states.tsx'
import type { Option } from './ProposalForm.tsx'
import { RequirementPicker } from './RequirementPicker.tsx'
import type { RequirementOption } from './requirementOptions.ts'
import { describeBlockers, promotionBlockers } from './promotion.ts'
import { REVIEW_ACTION_LABEL, isPromotable, proposalStatusLabel, reviewActionsFor, type ReviewAction } from './proposalStates.ts'

const FIELD =
  'mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'
const LABEL = 'block text-xs font-medium text-slate-700'

type Props = {
  proposal: Proposal | null
  members: Member[]
  departments: Option[]
  milestones: Option[]
  requirementOptions: RequirementOption[]
  // The requirement keys this proposal currently cites.
  requirementKeys: string[]
  isDeveloper: boolean
  hasTask: boolean
  onClose: () => void
  onDone: (message: string, options?: { toBoard?: boolean }) => void
}

// Review dialog for ONE proposal, for the people who may review it (its
// department's Head, or a Developer — the caller has already checked). It edits
// the persisted structured data, then approves through the one
// promote_proposal call. Nothing the reviewer changed is dropped: edits are
// saved in an explicit step BEFORE Approve or Park, and if that save fails the
// dialog stays open with the error and the values intact.
export function ReviewDialog({ proposal, onClose, ...rest }: Props) {
  const titleId = useId()
  return (
    <Dialog open={proposal !== null} onClose={onClose} labelledBy={titleId}>
      {proposal && <Form key={proposal.id} proposal={proposal} titleId={titleId} onClose={onClose} {...rest} />}
    </Dialog>
  )
}

function Form({
  proposal,
  members,
  departments,
  milestones,
  requirementOptions,
  requirementKeys,
  isDeveloper,
  hasTask,
  titleId,
  onClose,
  onDone,
}: Omit<Props, 'proposal'> & { proposal: Proposal; titleId: string }) {
  const update = useUpdateProposal()
  const review = useReviewProposal()
  const promote = usePromoteProposal()
  const setRequirements = useSetProposalRequirements()

  const [owner, setOwner] = useState(proposal.owner_id ?? '')
  const [dueDate, setDueDate] = useState(proposal.due_date ?? '')
  const [priority, setPriority] = useState<TaskPriority>(proposal.priority)
  const [milestone, setMilestone] = useState(proposal.milestone_key ?? '')
  const [department, setDepartment] = useState(proposal.subteam_key ?? '')
  const [keys, setKeys] = useState<string[]>(requirementKeys)
  const [note, setNote] = useState(proposal.decision ?? '')
  const [confirmReject, setConfirmReject] = useState(false)
  const [localError, setLocalError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  // A ref, not state: two clicks in the same tick both see the state as "idle".
  const working = useRef(false)

  const archived = proposal.archived_at !== null
  const actions = reviewActionsFor(proposal, hasTask)
  const activeMembers = members.filter((m) => m.status === 'active')
  const fid = (name: string) => `${titleId}-${name}`

  const blockers = promotionBlockers({
    departmentKey: department || null,
    dueDate: dueDate || null,
    milestoneKey: milestone || null,
    requirementCount: keys.length,
  })
  const canApprove = actions.length > 0 && isPromotable({ state: proposal.state, archived_at: proposal.archived_at, legacy_incomplete: false }) && blockers.length === 0

  const edit: ProposalEdit = { id: proposal.id }
  if (owner !== (proposal.owner_id ?? '')) edit.ownerId = owner || null
  if (dueDate && dueDate !== (proposal.due_date ?? '')) edit.dueDate = dueDate
  if (priority !== proposal.priority) edit.priority = priority
  if (milestone && milestone !== (proposal.milestone_key ?? '')) edit.milestoneKey = milestone
  if (isDeveloper && department && department !== (proposal.subteam_key ?? '')) edit.departmentKey = department
  if (note !== (proposal.decision ?? '')) edit.decision = note || null
  const fieldChanged = Object.keys(edit).length > 1
  const sameKeys = keys.length === requirementKeys.length && keys.every((k) => requirementKeys.includes(k))
  const changed = fieldChanged || !sameKeys

  // Save what the reviewer changed, fields first and then requirements (the
  // server clears an older proposal's "needs details" flag when both are
  // complete). Throws on the first refusal; nothing is retried or dropped.
  async function persist() {
    if (fieldChanged) await update.mutateAsync(edit)
    if (!sameKeys) await setRequirements.mutateAsync({ id: proposal.id, clauseKeys: keys })
  }

  async function run(work: () => Promise<void>) {
    if (working.current) return
    working.current = true
    setBusy(true)
    setLocalError(null)
    try {
      await work()
    } catch (error) {
      setLocalError(error instanceof Error ? error : new Error('That did not work.'))
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  const saveOnly = () =>
    run(async () => {
      await persist()
      onDone(`Saved “${proposal.title}”.`)
      onClose()
    })

  const approve = () =>
    run(async () => {
      await persist()
      // The proposal's own owner is read from the row just saved; passing the
      // chosen one keeps the request explicit.
      const { created } = await promote.mutateAsync({ proposal, ownerId: owner || null })
      onDone(created ? `“${proposal.title}” is on the Board.` : `“${proposal.title}” was already on the Board.`, { toBoard: true })
      onClose()
    })

  const command = (action: ReviewAction) =>
    run(async () => {
      await persist()
      await review.mutateAsync({ id: proposal.id, action })
      const done: Record<ReviewAction, string> = {
        review: `“${proposal.title}” is under review.`,
        park: `“${proposal.title}” is parked. Find it in the open queue, marked Parked.`,
        reject: `“${proposal.title}” is rejected and moved to History. It can be reopened there.`,
        reopen: `“${proposal.title}” is back in the open queue.`,
      }
      onDone(done[action])
      onClose()
    })

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void saveOnly()
      }}
    >
      <h2 id={titleId} className="text-base font-semibold text-balance text-slate-900">
        Review “{proposal.title}”
      </h2>
      <p className="mt-1 text-sm text-slate-700" data-testid="review-status">
        <span className="font-medium">{proposalStatusLabel(proposal)}</span>
        {proposal.context ? ` — ${proposal.context}` : ''}
      </p>

      {proposal.legacy_incomplete && (
        <p className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-900" data-testid="review-legacy">
          This older proposal cannot become a task yet. It still needs {describeBlockers(blockers) || 'a save to confirm the details'}.
          {isDeveloper || proposal.subteam_key
            ? ''
            : ' Only a Developer can choose its department.'}
        </p>
      )}
      {!proposal.legacy_incomplete && blockers.length > 0 && !archived && (
        <p className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-900" data-testid="review-blockers">
          It cannot be approved yet: it needs {describeBlockers(blockers)}.
        </p>
      )}

      {!archived && (
        <fieldset className="mt-3 grid gap-3" disabled={busy}>
          <legend className="sr-only">Details</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={fid('department')} className={LABEL}>
                Department
              </label>
              {isDeveloper ? (
                <select id={fid('department')} value={department} onChange={(e) => setDepartment(e.target.value)} className={FIELD}>
                  <option value="">Choose a department</option>
                  {departments.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              ) : (
                <p id={fid('department')} className="mt-1 min-h-11 py-2 text-sm text-slate-800 sm:min-h-0 sm:py-1.5">
                  {departments.find((d) => d.value === proposal.subteam_key)?.label ?? 'Not set'}
                </p>
              )}
            </div>
            <div>
              <label htmlFor={fid('owner')} className={LABEL}>
                Owner
              </label>
              <select id={fid('owner')} value={owner} onChange={(e) => setOwner(e.target.value)} className={FIELD}>
                <option value="">Nobody yet</option>
                {activeMembers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={fid('due')} className={LABEL}>
                Deadline
              </label>
              <input id={fid('due')} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={FIELD} />
            </div>
            <div>
              <label htmlFor={fid('priority')} className={LABEL}>
                Priority
              </label>
              <select id={fid('priority')} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} className={FIELD}>
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {TASK_PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={fid('milestone')} className={LABEL}>
                Milestone
              </label>
              <select id={fid('milestone')} value={milestone} onChange={(e) => setMilestone(e.target.value)} className={FIELD}>
                <option value="">Choose a milestone</option>
                {milestones.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div role="group" aria-labelledby={fid('req-label')}>
            <p id={fid('req-label')} className={LABEL}>
              Related requirements
            </p>
            <RequirementPicker id={fid('req')} options={requirementOptions} selected={keys} onChange={setKeys} disabled={busy} />
          </div>

          <div>
            <label htmlFor={fid('note')} className={LABEL}>
              Decision note (optional)
            </label>
            <textarea id={fid('note')} rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={FIELD} placeholder="What was discussed, and why…" />
          </div>
        </fieldset>
      )}

      {archived && proposal.decision && (
        <p className="mt-3 rounded bg-slate-50 p-2 text-sm text-slate-700">
          <span className="font-medium">Note:</span> {proposal.decision}
        </p>
      )}

      <ActionError error={localError} className="mt-3" />

      {confirmReject ? (
        <div className="mt-3 rounded border border-red-200 bg-red-50 p-3" role="alertdialog" aria-labelledby={fid('reject-q')}>
          <p id={fid('reject-q')} className="text-sm font-medium text-red-900">
            Reject this proposal?
          </p>
          <p className="mt-1 text-xs text-red-900">It moves to History as rejected. It can be reopened, and nothing is deleted.</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <button type="button" className={buttonDanger} disabled={busy} onClick={() => void command('reject')}>
              {busy ? 'Rejecting…' : 'Yes, reject it'}
            </button>
            <button type="button" className={buttonSecondary} disabled={busy} onClick={() => setConfirmReject(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <button type="button" className={buttonSecondary} disabled={busy} onClick={onClose}>
            Close
          </button>
          {!archived && (
            <button type="submit" className={buttonSecondary} disabled={busy || !changed} data-testid="review-save">
              Save details
            </button>
          )}
          {actions.includes('review') && (
            <button type="button" className={buttonSecondary} disabled={busy} onClick={() => void command('review')}>
              {REVIEW_ACTION_LABEL.review}
            </button>
          )}
          {actions.includes('park') && (
            <button type="button" className={buttonSecondary} disabled={busy} onClick={() => void command('park')} data-testid="review-park">
              {REVIEW_ACTION_LABEL.park}
            </button>
          )}
          {actions.includes('reopen') && (
            <button type="button" className={buttonSecondary} disabled={busy} onClick={() => void command('reopen')} data-testid="review-reopen">
              {REVIEW_ACTION_LABEL.reopen}
            </button>
          )}
          {actions.includes('reject') && (
            <button type="button" className={buttonDanger} disabled={busy} onClick={() => setConfirmReject(true)} data-testid="review-reject">
              {REVIEW_ACTION_LABEL.reject}
            </button>
          )}
          {actions.includes('review') || actions.includes('park') ? (
            <button
              type="button"
              className={buttonPrimary}
              disabled={busy || !canApprove}
              aria-describedby={blockers.length > 0 ? fid('why') : undefined}
              onClick={() => void approve()}
              data-testid="review-approve"
            >
              {busy ? 'Working…' : 'Approve and create task'}
            </button>
          ) : null}
        </div>
      )}
      {!confirmReject && blockers.length > 0 && !archived && (actions.includes('review') || actions.includes('park')) && (
        <p id={fid('why')} className="mt-2 text-right text-xs text-slate-600">
          Approve is unavailable until it has {describeBlockers(blockers)}.
        </p>
      )}
    </form>
  )
}
