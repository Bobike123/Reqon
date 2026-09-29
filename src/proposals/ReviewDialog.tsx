import { useId, useRef, useState } from 'react'
import type { Member } from '../data/useMembers.ts'
import {
  useAddProposalComment, useApproveProposal, usePromoteProposal, useRequestProposalChanges,
  useReviewProposal, useReviseProposal, useSetProposalDepartment,
  type Proposal, type ProposalChanges, type ProposalComment,
} from '../data/useProposals.ts'
import { formatInstant } from '../lib/dates.ts'
import { TASK_PRIORITIES, TASK_PRIORITY_LABEL } from '../tasks/priority.ts'
import type { TaskPriority } from '../tasks/types.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { buttonDanger, buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { ActionError } from '../ui/states.tsx'
import type { Option } from './ProposalForm.tsx'
import { RequirementPicker } from './RequirementPicker.tsx'
import type { RequirementOption } from './requirementOptions.ts'
import { describeBlockers, promotionBlockers } from './promotion.ts'
import { REVIEW_ACTION_LABEL, proposalStatusLabel, reviewActionsFor, type ReviewAction } from './proposalStates.ts'

const FIELD = 'mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:bg-slate-50 disabled:text-slate-500 sm:min-h-0'
const LABEL = 'block text-xs font-medium text-slate-700'

type Props = {
  proposal: Proposal | null
  comments: ProposalComment[]
  members: Member[]
  departments: Option[]
  milestones: Option[]
  requirementOptions: RequirementOption[]
  requirementKeys: string[]
  canReview: boolean
  isAuthor: boolean
  isDeveloper: boolean
  hasTask: boolean
  onClose: () => void
  onDone: (message: string, options?: { toBoard?: boolean }) => void
}

export function ReviewDialog({ proposal, onClose, ...rest }: Props) {
  const titleId = useId()
  return (
    <Dialog open={proposal !== null} onClose={onClose} labelledBy={titleId}>
      {proposal && <Form key={`${proposal.id}:${proposal.revision}`} proposal={proposal} titleId={titleId} onClose={onClose} {...rest} />}
    </Dialog>
  )
}

function Form({ proposal, comments, members, departments, milestones, requirementOptions, requirementKeys,
  canReview, isAuthor, isDeveloper, hasTask, titleId, onClose, onDone,
}: Omit<Props, 'proposal'> & { proposal: Proposal; titleId: string }) {
  const revise = useReviseProposal()
  const move = useSetProposalDepartment()
  const addComment = useAddProposalComment()
  const requestChanges = useRequestProposalChanges()
  const approve = useApproveProposal()
  const review = useReviewProposal()
  const promote = usePromoteProposal()

  const [title, setTitle] = useState(proposal.title)
  const [description, setDescription] = useState(proposal.context ?? '')
  const [owner, setOwner] = useState(proposal.owner_id ?? '')
  const [dueDate, setDueDate] = useState(proposal.due_date ?? '')
  const [priority, setPriority] = useState<TaskPriority>(proposal.priority)
  const [milestone, setMilestone] = useState(proposal.milestone_key ?? '')
  const [department, setDepartment] = useState(proposal.subteam_key ?? '')
  const [keys, setKeys] = useState<string[]>(requirementKeys)
  const [revisionNote, setRevisionNote] = useState('')
  const [moveReason, setMoveReason] = useState('')
  const [actionNote, setActionNote] = useState('')
  const [comment, setComment] = useState('')
  const [confirmReject, setConfirmReject] = useState(false)
  const [localError, setLocalError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)
  const working = useRef(false)

  const archived = proposal.archived_at !== null
  const closed = archived || proposal.state === 'decided'
  const authorMayEdit = isAuthor && ['open', 'agenda', 'changes_requested'].includes(proposal.state)
  const reviewerMayEdit = canReview && !['parked', 'decided'].includes(proposal.state)
  const canEdit = !archived && (authorMayEdit || reviewerMayEdit)
  const canMove = canEdit && (isDeveloper || canReview || (isAuthor && proposal.state === 'open'))
  const actions = canReview ? reviewActionsFor(proposal, hasTask) : []
  const activeMembers = members.filter((member) => member.status === 'active')
  const fid = (name: string) => `${titleId}-${name}`

  const sameKeys = keys.length === requirementKeys.length && keys.every((key) => requirementKeys.includes(key))
  const departmentChanged = department !== (proposal.subteam_key ?? '')
  const changes: ProposalChanges = {}
  if (title !== proposal.title) changes.title = title
  if (description !== (proposal.context ?? '')) changes.description = description || null
  if (owner !== (proposal.owner_id ?? '')) changes.ownerId = owner || null
  if (dueDate !== (proposal.due_date ?? '')) changes.dueDate = dueDate || null
  if (priority !== proposal.priority) changes.priority = priority
  if (milestone !== (proposal.milestone_key ?? '')) changes.milestoneKey = milestone || null
  if (!sameKeys) changes.requirementKeys = keys
  const contentChanged = Object.keys(changes).length > 0
  const changed = departmentChanged || contentChanged
  const blockers = promotionBlockers({ departmentKey: department || null, dueDate: dueDate || null,
    milestoneKey: milestone || null, requirementCount: keys.length })
  const approved = proposal.state === 'approved' && proposal.approved_revision === proposal.revision
  const approvalReady = canReview && ['open', 'agenda', 'changes_requested'].includes(proposal.state)
    && blockers.length === 0 && !proposal.legacy_incomplete && !changed && actionNote.trim().length > 0

  async function run(work: () => Promise<void>) {
    if (working.current) return
    working.current = true
    setBusy(true)
    setLocalError(null)
    try { await work() } catch (error) {
      setLocalError(error instanceof Error ? error : new Error('That did not work.'))
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  async function saveRevision() {
    if (departmentChanged && contentChanged) {
      throw new Error('Save the department move separately, then reopen the proposal and save the other changes against its new revision.')
    }
    if (departmentChanged) {
      if (!department) throw new Error('Choose a department.')
      if (!moveReason.trim()) throw new Error('Say why the proposal changes department.')
      await move.mutateAsync({ id: proposal.id, departmentKey: department, reason: moveReason, expectedRevision: proposal.revision })
    } else if (contentChanged) {
      await revise.mutateAsync({ id: proposal.id, expectedRevision: proposal.revision, changes, note: revisionNote })
    }
  }

  const saveOnly = () => run(async () => {
    await saveRevision()
    onDone(`Saved the new revision of “${proposal.title}”.`)
    onClose()
  })
  const sendComment = () => run(async () => {
    await addComment.mutateAsync({ id: proposal.id, body: comment })
    setComment('')
    onDone(`Added your comment to “${proposal.title}”.`)
  })
  const doApprove = () => run(async () => {
    await approve.mutateAsync({ id: proposal.id, expectedRevision: proposal.revision, note: actionNote })
    onDone(`Approved revision ${proposal.revision} of “${proposal.title}”. It can now be made into a task.`)
    onClose()
  })
  const doRequestChanges = () => run(async () => {
    await requestChanges.mutateAsync({ id: proposal.id, expectedRevision: proposal.revision, note: actionNote })
    onDone(`Requested changes to “${proposal.title}”.`)
    onClose()
  })
  const doPromote = () => run(async () => {
    const { created } = await promote.mutateAsync({ proposal })
    onDone(created ? `“${proposal.title}” is on the Board.` : `“${proposal.title}” was already on the Board.`, { toBoard: true })
    onClose()
  })
  const command = (action: ReviewAction) => run(async () => {
    await review.mutateAsync({ id: proposal.id, action, expectedRevision: proposal.revision, note: actionNote })
    const done: Record<ReviewAction, string> = {
      review: `“${proposal.title}” is under review.`, park: `“${proposal.title}” is parked.`,
      reject: `“${proposal.title}” is rejected and moved to History.`, reopen: `“${proposal.title}” is back in the open queue.`,
    }
    onDone(done[action])
    onClose()
  })

  return (
    <form noValidate onSubmit={(event) => { event.preventDefault(); if (changed) void saveOnly() }}>
      <h2 id={titleId} className="text-base font-semibold text-balance text-slate-900">Proposal “{proposal.title}”</h2>
      <p className="mt-1 text-sm text-slate-700" data-testid="review-status">
        <span className="font-medium">{proposalStatusLabel(proposal)}</span> · revision {proposal.revision}
      </p>
      {proposal.legacy_incomplete && (
        <p className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-900" data-testid="review-legacy">
          This older proposal cannot be approved yet. It still needs {describeBlockers(blockers) || 'its details confirmed'}.
        </p>
      )}
      {!proposal.legacy_incomplete && blockers.length > 0 && !closed && (
        <p className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-900" data-testid="review-blockers">
          It cannot be approved yet: it needs {describeBlockers(blockers)}.
        </p>
      )}
      {proposal.state === 'changes_requested' && <p className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-900">The reviewer requested changes. Saving a revision returns it to review.</p>}
      {approved && <p className="mt-2 rounded bg-emerald-50 p-2 text-sm text-emerald-900" data-testid="review-approved">Revision {proposal.approved_revision} was approved. Any material reviewer edit withdraws that approval.</p>}

      <section className="mt-3" aria-labelledby={fid('discussion-heading')}>
        <h3 id={fid('discussion-heading')} className="text-sm font-semibold text-slate-900">Discussion</h3>
        {comments.length === 0 ? <p className="mt-1 text-sm text-slate-600">No discussion yet.</p> : (
          <ol className="mt-1 max-h-48 space-y-2 overflow-y-auto rounded border border-slate-200 p-2" data-testid="proposal-discussion">
            {comments.map((entry) => {
              const author = members.find((member) => member.id === entry.author_id)?.full_name ?? 'Former member'
              const label = entry.kind === 'comment' ? 'Comment' : entry.kind.replace('_', ' ')
              return <li key={entry.id} className="text-sm text-slate-700">
                <p><span className="font-medium text-slate-900">{author}</span> · {label} · revision {entry.revision}</p>
                <p className="whitespace-pre-wrap">{entry.body}</p>
                <p className="text-xs text-slate-500">{formatInstant(entry.created_at)}</p>
              </li>
            })}
          </ol>
        )}
        {!closed && <div className="mt-2">
          <label htmlFor={fid('comment')} className={LABEL}>Add a comment</label>
          <textarea id={fid('comment')} rows={2} value={comment} onChange={(event) => setComment(event.target.value)} className={FIELD} maxLength={2000} disabled={busy} />
          <button type="button" className={`${buttonSecondary} mt-2`} disabled={busy || !comment.trim()} onClick={() => void sendComment()} data-testid="review-comment">Add comment</button>
        </div>}
      </section>

      {!closed && <fieldset className="mt-4 grid gap-3" disabled={busy || !canEdit}>
        <legend className="text-sm font-semibold text-slate-900">Proposal content</legend>
        <div><label htmlFor={fid('title')} className={LABEL}>Title</label><input id={fid('title')} value={title} onChange={(event) => setTitle(event.target.value)} className={FIELD} maxLength={200} required /></div>
        <div><label htmlFor={fid('description')} className={LABEL}>Description</label><textarea id={fid('description')} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} className={FIELD} /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label htmlFor={fid('department')} className={LABEL}>Department</label><select id={fid('department')} value={department} onChange={(event) => setDepartment(event.target.value)} className={FIELD} disabled={!canMove || busy}><option value="">Choose a department</option>{departments.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
          <div><label htmlFor={fid('owner')} className={LABEL}>Owner</label><select id={fid('owner')} value={owner} onChange={(event) => setOwner(event.target.value)} className={FIELD}><option value="">Nobody yet</option>{activeMembers.map((member) => <option key={member.id} value={member.id}>{member.full_name}</option>)}</select></div>
          <div><label htmlFor={fid('due')} className={LABEL}>Deadline</label><input id={fid('due')} type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className={FIELD} required /></div>
          <div><label htmlFor={fid('priority')} className={LABEL}>Priority</label><select id={fid('priority')} value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)} className={FIELD}>{TASK_PRIORITIES.map((value) => <option key={value} value={value}>{TASK_PRIORITY_LABEL[value]}</option>)}</select></div>
          <div className="sm:col-span-2"><label htmlFor={fid('milestone')} className={LABEL}>Milestone</label><select id={fid('milestone')} value={milestone} onChange={(event) => setMilestone(event.target.value)} className={FIELD} required><option value="">Choose a milestone</option>{milestones.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
        </div>
        <div role="group" aria-labelledby={fid('req-label')}><p id={fid('req-label')} className={LABEL}>Related requirements</p><RequirementPicker id={fid('req')} options={requirementOptions} selected={keys} onChange={setKeys} disabled={busy || !canEdit} /></div>
        {departmentChanged ? <div><label htmlFor={fid('move-reason')} className={LABEL}>Why this department changes</label><textarea id={fid('move-reason')} rows={2} value={moveReason} onChange={(event) => setMoveReason(event.target.value)} className={FIELD} maxLength={500} required /></div>
          : <div><label htmlFor={fid('revision-note')} className={LABEL}>Revision note (optional)</label><textarea id={fid('revision-note')} rows={2} value={revisionNote} onChange={(event) => setRevisionNote(event.target.value)} className={FIELD} maxLength={2000} /></div>}
      </fieldset>}

      {canReview && !hasTask && !closed && <div className="mt-4"><label htmlFor={fid('action-note')} className={LABEL}>Review note</label><textarea id={fid('action-note')} rows={2} value={actionNote} onChange={(event) => setActionNote(event.target.value)} className={FIELD} maxLength={2000} disabled={busy} placeholder="Required for approval and change requests" /></div>}
      {changed && canReview && <p className="mt-2 text-xs text-amber-800" data-testid="review-save-first">Save this revision before taking a review action.</p>}
      <ActionError error={localError} className="mt-3" />

      {confirmReject ? <div className="mt-3 rounded border border-red-200 bg-red-50 p-3" role="alertdialog" aria-labelledby={fid('reject-q')}>
        <p id={fid('reject-q')} className="text-sm font-medium text-red-900">Reject this proposal?</p><p className="mt-1 text-xs text-red-900">It moves to History. Its discussion and revisions remain attributable.</p>
        <div className="mt-2 flex gap-2"><button type="button" className={buttonDanger} disabled={busy} onClick={() => void command('reject')}>Yes, reject it</button><button type="button" className={buttonSecondary} disabled={busy} onClick={() => setConfirmReject(false)}>Keep it</button></div>
      </div> : <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        <button type="button" className={buttonSecondary} disabled={busy} onClick={onClose}>Close</button>
        {canEdit && !closed && <button type="submit" className={buttonSecondary} disabled={busy || !changed || (departmentChanged && !moveReason.trim())} data-testid="review-save">Save revision</button>}
        {actions.includes('review') && <button type="button" className={buttonSecondary} disabled={busy || changed} onClick={() => void command('review')}>{REVIEW_ACTION_LABEL.review}</button>}
        {actions.includes('park') && <button type="button" className={buttonSecondary} disabled={busy || changed} onClick={() => void command('park')} data-testid="review-park">{REVIEW_ACTION_LABEL.park}</button>}
        {actions.includes('reopen') && <button type="button" className={buttonSecondary} disabled={busy} onClick={() => void command('reopen')} data-testid="review-reopen">{REVIEW_ACTION_LABEL.reopen}</button>}
        {actions.includes('reject') && <button type="button" className={buttonDanger} disabled={busy || changed} onClick={() => setConfirmReject(true)} data-testid="review-reject">{REVIEW_ACTION_LABEL.reject}</button>}
        {canReview && ['open', 'agenda', 'approved'].includes(proposal.state) && <button type="button" className={buttonSecondary} disabled={busy || changed || !actionNote.trim()} onClick={() => void doRequestChanges()} data-testid="review-request-changes">Request changes</button>}
        {canReview && ['open', 'agenda', 'changes_requested'].includes(proposal.state) && <button type="button" className={buttonPrimary} disabled={busy || !approvalReady} onClick={() => void doApprove()} data-testid="review-approve">{busy ? 'Working…' : 'Approve revision'}</button>}
        {canReview && approved && !hasTask && <button type="button" className={buttonPrimary} disabled={busy} onClick={() => void doPromote()} data-testid="review-promote">{busy ? 'Working…' : 'Create Board task'}</button>}
      </div>}
    </form>
  )
}
