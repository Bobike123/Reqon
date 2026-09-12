import { useCallback, useMemo, useState } from 'react'
import { usePermissions } from '../auth/usePermissions.ts'
import { useMembers } from '../data/useMembers.ts'
import { useTasks } from '../data/useTasks.ts'
import {
  usePromoteProposal,
  useSuggestProposal,
  useProposals,
  useUpdateProposal,
  type Proposal,
  type ProposalState,
} from '../data/useProposals.ts'
import { ErrorState } from '../ui/states.tsx'
import { SuggestProposalForm } from './SuggestProposalForm.tsx'
import { ProposalCard } from './ProposalCard.tsx'
import { PROPOSAL_STATES } from './proposalStates.ts'
import { PromoteDialog } from './PromoteDialog.tsx'

// The proposal workspace. BOTH the Now screen and the Proposals screen render
// this exact component, so suggesting, reviewing and promoting behave the same
// wherever you are. There is deliberately no second implementation.
export function ProposalsPanel({
  heading,
  states,
  emptyHint,
  layout = 'stack',
}: {
  heading: string
  // Which stages to show. Now shows the live ones; the Proposals screen shows
  // everything, including parked.
  states?: ProposalState[]
  emptyHint: string
  // 'stack' is one column: the Now screen, and every screen on a phone.
  // 'wide' is for a meeting on a big screen: the form and a running tally stay
  // in a left-hand column while the cards fill the rest of the width.
  layout?: 'stack' | 'wide'
}) {
  const proposals = useProposals()
  const members = useMembers()
  const tasks = useTasks()
  const createProposal = useSuggestProposal()
  const updateProposal = useUpdateProposal()
  const promote = usePromoteProposal()
  const can = usePermissions()
  const wide = layout === 'wide'

  const tasksByProposal = useMemo(() => {
    const map = new Map<string, (typeof tasks.data extends undefined ? never : NonNullable<typeof tasks.data>)[number]>()
    for (const task of tasks.data ?? []) {
      if (task.source_proposal) map.set(task.source_proposal, task)
    }
    return map
  }, [tasks.data])

  const visible = useMemo(() => {
    const all = proposals.data ?? []
    return states ? all.filter((t) => states.includes(t.state)) : all
  }, [proposals.data, states])

  const onRaise = useCallback(
    async (title: string, context: string | null) => {
      await createProposal.mutateAsync({ title, context })
    },
    [createProposal],
  )

  const onSetState = useCallback(
    (id: string, state: ProposalState) => updateProposal.mutate({ id, state }),
    [updateProposal],
  )
  const onSetDecision = useCallback(
    (id: string, decision: string) => updateProposal.mutate({ id, decision: decision || null }),
    [updateProposal],
  )
  const onSetOwner = useCallback(
    (id: string, ownerId: string | null) => updateProposal.mutate({ id, ownerId }),
    [updateProposal],
  )
  // Promotion asks for an owner, a date and a lane first: the promoter decides
  // those, and the database only lets an administrator do it at all.
  const [promotingProposal, setPromotingProposal] = useState<Proposal | null>(null)
  const [promotedMessage, setPromotedMessage] = useState('')
  const onPromote = useCallback((proposal: Proposal) => setPromotingProposal(proposal), [])

  const writeError = updateProposal.error

  const raise = (
    <SuggestProposalForm
      onRaise={onRaise}
      pending={createProposal.isPending}
      error={createProposal.error ? createProposal.error.message : null}
    />
  )

  const list = (
    <div className={wide ? 'mt-3 space-y-2 lg:mt-0' : 'mt-2 space-y-2'}>
      {writeError && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          Could not save that change: {writeError.message}
        </p>
      )}
      {updateProposal.isPending && (
        <p role="status" className="text-xs text-slate-500">
          Saving…
        </p>
      )}

      {proposals.error && (
        <ErrorState
          title="Could not load proposals"
          error={proposals.error}
          onRetry={() => void proposals.refetch()}
        />
      )}

      {!proposals.isLoading && visible.length === 0 && (
        <p className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          {emptyHint}
        </p>
      )}

      <ul
        className={wide ? 'grid items-start gap-3 xl:grid-cols-2 min-[100rem]:grid-cols-3' : 'space-y-2'}
        data-testid="proposal-list"
      >
        {visible.map((proposal, index) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            members={members.data ?? []}
            taskFromProposal={tasksByProposal.get(proposal.id)}
            promoting={promote.isPending && promotingProposal?.id === proposal.id}
            canReview={can.canPromoteProposal}
            onSetState={onSetState}
            onSetDecision={onSetDecision}
            onSetOwner={onSetOwner}
            onPromote={onPromote}
            tutorial={index === 0}
          />
        ))}
      </ul>
    </div>
  )

  return (
    <section aria-labelledby="proposals-heading" data-tutorial="proposals-panel">
      <h2 id="proposals-heading" className="mb-2 text-sm font-semibold text-slate-900">
        {heading}
      </h2>

      {wide ? (
        <div className="lg:grid lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)] lg:items-start lg:gap-6">
          <div className="space-y-3 lg:sticky lg:top-4">
            {raise}
            <ProposalTally proposals={visible} promoted={tasksByProposal.size} />
          </div>
          {list}
        </div>
      ) : (
        <>
          {raise}
          {list}
        </>
      )}

      <p role="status" className="mt-2 min-h-5 text-sm text-emerald-800">
        {promotedMessage}
      </p>

      <PromoteDialog
        proposal={promotingProposal}
        members={members.data ?? []}
        onClose={() => setPromotingProposal(null)}
        onPromoted={(message) => {
          setPromotingProposal(null)
          setPromotedMessage(message)
        }}
      />
    </section>
  )
}

// Where every proposal stands, as plain numbers. Deliberately not a set of
// filters: a card that vanished the moment someone changed its state would
// pull the discussion out from under the room.
function ProposalTally({ proposals, promoted }: { proposals: Proposal[]; promoted: number }) {
  const count = (state: ProposalState) => proposals.filter((t) => t.state === state).length
  const flow = PROPOSAL_STATES.filter((s) => s.value !== 'parked')
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3" data-tutorial="proposal-flow">
      <h3 className="text-xs font-medium text-slate-600">How a proposal moves</h3>
      <ol className="mt-2 space-y-1 text-sm">
        {flow.map((state, index) => (
          <li key={state.value} className="flex items-baseline justify-between gap-3">
            <span className="text-slate-800">
              <span className="text-slate-500">{index + 1}.</span> {state.label}
            </span>
            <span className="text-slate-700 tabular-nums">
              {count(state.value)}
              <span className="sr-only"> proposals</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-pretty text-slate-600">
        The President, Vice President or a Developer reviews these and promotes the ones the club
        takes on.{' '}
        <span className="tabular-nums">{promoted}</span> promoted so far. Parked proposals (
        <span className="tabular-nums">{count('parked')}</span>) are set aside, not deleted.
      </p>
    </div>
  )
}
