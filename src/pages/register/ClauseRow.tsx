import { memo, useState } from 'react'
import type { ClauseState } from '../../data/useClauseStatus.ts'
import type { Member } from '../../data/useMembers.ts'
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
  tutorialId?: string
}

function ClauseRowInner({
  row,
  members,
  onSetState,
  onSetOwner,
  onSetEvidence,
  onToggleStar,
  tutorialId,
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

  return (
    <li
      className={`border-b border-slate-200 px-3 py-3 sm:px-4 xl:grid xl:grid-cols-[minmax(0,1fr)_28rem] xl:items-start xl:gap-x-8 ${parked ? 'bg-slate-50' : ''}`}
      data-clause-key={clause.clause_key}
      data-parked={parked ? 'true' : 'false'}
      data-tutorial={tutorialId}
    >
      <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-bold text-slate-900">
          {clause.printed_ref}
        </span>
        {badge && (
          <span
            className={`rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide ${badge.className}`}
            title={badge.title}
          >
            {badge.label}
          </span>
        )}
        {parked && (
          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
            PARKED — Final Event
          </span>
        )}
        <span className="text-[11px] uppercase tracking-wide text-slate-500">
          {clause.obligation}
        </span>
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
          className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
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
