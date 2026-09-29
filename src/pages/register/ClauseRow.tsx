import { memo, useState } from 'react'
import { Link } from 'react-router-dom'
import { obligationInfo, PARKED_INFO } from '../../clauses/labels.ts'
import { clausePageTarget, targetHref, targetNote } from '../../book/source.ts'
import type { ClauseState } from '../../data/useClauseStatus.ts'
import type { Member } from '../../data/useMembers.ts'
import { ExplainedLabel } from '../../ui/ExplainedLabel.tsx'
import { ClauseLinkedWork } from './ClauseLinkedWork.tsx'
import type { LinkedWork } from './linkedWork.ts'
import {
  criticalityBadge,
  formatSpec,
  readSpecs,
  type RegisterRow,
} from './registerModel.ts'

const STATES: { value: ClauseState; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'wip', label: 'In progress' },
  { value: 'compliant', label: 'Compliant' },
  { value: 'verified', label: 'Verified' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'na', label: 'Not applicable' },
]

type Props = {
  row: RegisterRow
  members: Member[]
  onSetState: (clauseKey: string, state: ClauseState) => void
  onSetOwner: (clauseKey: string, ownerId: string | null) => void
  onSetEvidence: (clauseKey: string, evidence: string) => void
  onToggleStar: (clauseKey: string, starred: boolean) => void
  // The work linked to this requirement.
  work: LinkedWork
  linkAvailability: 'ready' | 'loading' | 'unavailable'
  // The edition this season reads. A recorded page is only used when the clause
  // belongs to that same edition. A string, not an object, so memo() holds.
  seasonRegsRef: string | null
  memberNames: ReadonlyMap<string, string>
  departmentNames: ReadonlyMap<string, string>
  tutorialId?: string
  // Opens this rule in the Register's own reader pane. The link keeps its real
  // address (/book?page=…), so a new tab or a copied link still works.
  onOpenBook?: (clauseKey: string) => void
  // True while this rule is the one shown in the reader.
  reading?: boolean
}

function ClauseRowInner({
  row,
  members,
  onSetState,
  onSetOwner,
  onSetEvidence,
  onToggleStar,
  work,
  linkAvailability,
  seasonRegsRef,
  memberNames,
  departmentNames,
  tutorialId,
  onOpenBook,
  reading = false,
}: Props) {
  const { clause } = row
  const badge = criticalityBadge(clause.criticality)
  const specs = readSpecs(clause.specs)
  const serverEvidence = row.evidence ?? ''
  const [evidence, setEvidence] = useState(serverEvidence)
  const [lastSeen, setLastSeen] = useState(serverEvidence)

  // Adjust state during render rather than in an effect: when the server value
  // actually changes (someone else edited this rule), follow it. Local typing
  // is untouched because serverEvidence has not moved.
  if (lastSeen !== serverEvidence) {
    setLastSeen(serverEvidence)
    setEvidence(serverEvidence)
  }

  // Parked rules (Race Operations) only bite at the Final Event. Dimmed so they
  // do not compete for attention — but still present, still searchable, still
  // editable. Never hidden.
  const parked = row.isParked
  const bookTarget = clausePageTarget(clause, seasonRegsRef)
  // New owners are active members; a current owner who has since retired stays
  // visible (and selected), marked, instead of silently reading as unassigned.
  const active = members.filter((m) => m.status === 'active')
  const owners =
    row.ownerId && !active.some((m) => m.id === row.ownerId)
      ? [...active, { id: row.ownerId, full_name: `${memberNames.get(row.ownerId) ?? 'Someone'} (no longer active)` }]
      : active

  return (
    <li
      className={`border-b border-slate-200 px-3 py-3 sm:px-4 xl:grid xl:grid-cols-[minmax(0,1fr)_28rem] xl:items-start xl:gap-x-8 ${reading ? 'bg-amber-50 ring-2 ring-inset ring-amber-400' : parked ? 'bg-slate-50' : ''}`}
      data-clause-key={clause.clause_key}
      data-parked={parked ? 'true' : 'false'}
      data-tutorial={tutorialId}
    >
      <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-bold text-slate-900">
          {clause.printed_ref}
        </span>
        {badge && <ExplainedLabel info={badge.info} className={badge.className} testId={`criticality-${clause.clause_key}`} />}
        {parked && (
          <ExplainedLabel info={PARKED_INFO} className="bg-slate-200 font-medium text-slate-700" testId={`parked-${clause.clause_key}`} />
        )}
        <ExplainedLabel
          info={obligationInfo(clause.obligation)}
          className="font-normal uppercase text-slate-600 underline decoration-dotted underline-offset-2"
          testId={`obligation-${clause.clause_key}`}
        />
        {specs.map((spec, i) => (
          <span
            key={i}
            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-700"
          >
            {formatSpec(spec)}
          </span>
        ))}
      </div>

      <p className={`mt-1 max-w-[80ch] text-sm ${parked ? 'text-slate-500' : 'text-slate-800'}`}>
        {clause.body}
      </p>

      <div data-tutorial={tutorialId ? 'register-links' : undefined}>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <Link
          to={targetHref(bookTarget, clause.printed_ref)}
          onClick={(event) => {
            // A plain click reads it here, beside the rules; a modified click
            // (new tab/window) follows the real address.
            if (!onOpenBook || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
            event.preventDefault()
            onOpenBook(clause.clause_key)
          }}
          aria-current={reading ? 'true' : undefined}
          data-testid={`book-link-${clause.clause_key}`}
          className="inline-flex min-h-11 items-center rounded text-slate-800 underline decoration-slate-400 underline-offset-2 hover:decoration-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
        >
          Open in Requirements Book
          <span className="sr-only"> for {clause.printed_ref}</span>
        </Link>
        {targetNote(bookTarget) && (
          <span className="text-slate-600" data-testid="book-note">
            {targetNote(bookTarget)}
          </span>
        )}
      </div>

      <ClauseLinkedWork
        clauseKey={clause.clause_key}
        printedRef={clause.printed_ref}
        state={row.state}
        work={work}
        availability={linkAvailability}
        memberNames={memberNames}
        departmentNames={departmentNames}
        onMarkCompliant={(key) => onSetState(key, 'compliant')}
      />
      </div>
      </div>

      {/* On a wide screen the controls get a column of their own: the rule
          reads on the left, what the team did about it lines up on the right. */}
      <div
        className="mt-2 flex flex-wrap items-center gap-2 xl:mt-0"
        data-tutorial={tutorialId ? 'register-row-controls' : undefined}
      >
        <label className="sr-only" htmlFor={`state-${clause.clause_key}`}>
          Status for {clause.printed_ref}
        </label>
        <select
          id={`state-${clause.clause_key}`}
          value={row.state}
          onChange={(e) => onSetState(clause.clause_key, e.target.value as ClauseState)}
          className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
        >
          {STATES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor={`owner-${clause.clause_key}`}>
          Owner for {clause.printed_ref}
        </label>
        <select
          id={`owner-${clause.clause_key}`}
          value={row.ownerId ?? ''}
          onChange={(e) => onSetOwner(clause.clause_key, e.target.value || null)}
          className="min-h-11 w-full max-w-full min-w-0 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0 sm:w-48"
        >
          <option value="">Unassigned</option>
          {owners.map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor={`evidence-${clause.clause_key}`}>
          Evidence for {clause.printed_ref}
        </label>
        <input
          id={`evidence-${clause.clause_key}`}
          type="text"
          placeholder="Evidence…"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          onBlur={() => {
            if (evidence !== serverEvidence) {
              onSetEvidence(clause.clause_key, evidence)
            }
          }}
          className="min-h-11 w-full min-w-0 rounded border border-slate-300 px-2 py-1 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0 sm:w-auto sm:flex-1 xl:order-last xl:basis-full"
        />

        <button
          type="button"
          aria-pressed={row.starred}
          aria-label={`${row.starred ? 'Unstar' : 'Star'} ${clause.printed_ref}`}
          onClick={() => onToggleStar(clause.clause_key, !row.starred)}
          className={`min-h-11 min-w-11 rounded border px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0 sm:min-w-0 ${
            row.starred
              ? 'border-amber-400 bg-amber-100 text-amber-900'
              : 'border-slate-300 bg-white text-slate-500'
          }`}
        >
          {row.starred ? '★' : '☆'}
        </button>
      </div>
    </li>
  )
}

// 1,146 rows: without memo, every keystroke in the search box would re-render
// all of them.
export const ClauseRow = memo(ClauseRowInner)
