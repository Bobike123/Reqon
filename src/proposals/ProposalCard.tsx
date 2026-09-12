import { Link } from 'react-router-dom'
import { useState } from 'react'
import type { Member } from '../data/useMembers.ts'
import type { Task } from '../data/useTasks.ts'
import type { Proposal, ProposalState } from '../data/useProposals.ts'
import { PROPOSAL_STATES, proposalStateLabel } from './proposalStates.ts'

// ONE proposal card, used by BOTH the Proposals screen and the Now screen.
// Do not fork this for a second screen — the whole point of Prompt 0's rule
// that proposals are editable from Now as well is that they behave identically.
//
// `canReview` mirrors proposal_update in the database: only an administrator
// may change a proposal's stage, owner or decision, or promote it. A member
// sees the same card, reads the same facts, and is offered no control that
// would come back refused.

type Props = {
  proposal: Proposal
  members: Member[]
  taskFromProposal?: Task
  promoting: boolean
  canReview: boolean
  onSetState: (id: string, state: ProposalState) => void
  onSetDecision: (id: string, decision: string) => void
  onSetOwner: (id: string, ownerId: string | null) => void
  onPromote: (proposal: Proposal) => void
  // The one card the guided tour points at.
  tutorial?: boolean
}

export function ProposalCard({
  proposal,
  members,
  taskFromProposal,
  promoting,
  canReview,
  onSetState,
  onSetDecision,
  onSetOwner,
  onPromote,
  tutorial = false,
}: Props) {
  const serverDecision = proposal.decision ?? ''
  const [decision, setDecision] = useState(serverDecision)
  const [lastSeen, setLastSeen] = useState(serverDecision)

  // Follow the server if someone else edits, without clobbering local typing.
  if (lastSeen !== serverDecision) {
    setLastSeen(serverDecision)
    setDecision(serverDecision)
  }

  const nameOf = (id: string | null) =>
    id ? (members.find((m) => m.id === id)?.full_name ?? 'someone no longer on the roster') : null
  const promoted = Boolean(taskFromProposal)
  const owner = nameOf(proposal.owner_id)
  const suggester = nameOf(proposal.raised_by)

  return (
    <li
      className="rounded-lg border border-slate-200 bg-white p-3"
      data-testid={`proposal-${proposal.id}`}
      data-proposal-state={proposal.state}
      data-tutorial={tutorial ? 'proposal-card' : undefined}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{proposal.title}</h3>
        {proposal.starred && <span aria-label="Starred">★</span>}
      </div>
      {proposal.context && <p className="mt-0.5 text-sm text-slate-600">{proposal.context}</p>}
      <p className="mt-0.5 text-xs text-slate-500">
        Suggested{suggester ? ` by ${suggester}` : ''} on {proposal.raised_on}
      </p>

      {canReview ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`proposal-state-${proposal.id}`}>
            Stage for {proposal.title}
          </label>
          <select
            id={`proposal-state-${proposal.id}`}
            value={proposal.state}
            onChange={(e) => onSetState(proposal.id, e.target.value as ProposalState)}
            className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          >
            {PROPOSAL_STATES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor={`proposal-owner-${proposal.id}`}>
            Owner for {proposal.title}
          </label>
          <select
            id={`proposal-owner-${proposal.id}`}
            value={proposal.owner_id ?? ''}
            onChange={(e) => onSetOwner(proposal.id, e.target.value || null)}
            className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        // A member reads the same two facts as a plain sentence: the stage, and
        // who is looking after it. No control the database would refuse.
        <p className="mt-2 text-sm text-slate-700" data-testid={`proposal-status-${proposal.id}`}>
          <span className="font-medium">{proposalStateLabel(proposal.state)}</span>
          {owner ? ` · with ${owner}` : ''}
        </p>
      )}

      {/* Editable in EVERY stage, on purpose. A proposal must never become a
          dead end because of the stage it happens to be in — the decision can
          be written before it is marked decided, and corrected afterwards. */}
      {canReview ? (
        <div className="mt-2" data-tutorial={tutorial ? 'proposal-decision' : undefined}>
          <label
            id={`proposal-decision-label-${proposal.id}`}
            className="block text-xs font-medium text-slate-600"
            htmlFor={`proposal-decision-${proposal.id}`}
          >
            Decision
          </label>
          <textarea
            id={`proposal-decision-${proposal.id}`}
            // Explicit association as well as htmlFor: assistive tech and test
            // queries both resolve the name without guessing.
            aria-labelledby={`proposal-decision-label-${proposal.id}`}
            rows={2}
            value={decision}
            placeholder="What was decided, and why…"
            onChange={(e) => setDecision(e.target.value)}
            onBlur={() => {
              if (decision !== serverDecision) onSetDecision(proposal.id, decision)
            }}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
          />
        </div>
      ) : (
        serverDecision && (
          <p className="mt-2 rounded bg-slate-50 p-2 text-sm text-slate-700">
            <span className="font-medium">Decision:</span> {serverDecision}
          </p>
        )
      )}

      <div
        className="mt-2 flex flex-wrap items-center gap-2"
        data-tutorial={tutorial ? 'proposal-promote' : undefined}
      >
        {promoted ? (
          <span
            className="pc-fade-in inline-flex flex-wrap items-center gap-2 rounded bg-slate-100 px-2 py-1 text-xs text-slate-700"
            data-testid={`proposal-promoted-${proposal.id}`}
          >
            On the Board as “{taskFromProposal?.title}”
            <Link
              to="/board"
              className="rounded font-medium text-slate-900 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
            >
              Open on Board
            </Link>
          </span>
        ) : canReview ? (
          <button
            type="button"
            // Disabled while in flight so a second click cannot start a second
            // insert. The mutation is idempotent as well — see
            // usePromoteProposal.
            disabled={promoting}
            onClick={() => onPromote(proposal)}
            data-testid={`promote-${proposal.id}`}
            className="min-h-11 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
          >
            {promoting ? 'Promoting…' : 'Promote to task'}
          </button>
        ) : (
          <p className="text-xs text-slate-500">
            The President, Vice President or a Developer decides whether this becomes a board task.
          </p>
        )}
      </div>
    </li>
  )
}
