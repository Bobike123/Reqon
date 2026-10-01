import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { RecordMeasurement, SpecVerdict } from '../../data/useSpecs.ts'
import { formatInstant } from '../../lib/dates.ts'
import { competitionCell, idealCell, measurementValue, regulatoryLimitText, zoneCue } from '../../specs/presentation.ts'
import { buttonSecondary } from '../../ui/buttons.ts'
import { MeasurementEditor } from './MeasurementEditor.tsx'
import { DirectionPanel, ReadinessPanel } from './ReadinessPanel.tsx'
import { SpecStatuses, SpecThresholds } from './SpecComparison.tsx'
import { SpecHistory } from './SpecHistory.tsx'

// The same column template for the header row and every spec row.
export const SPEC_COLUMNS = 'md:grid md:grid-cols-[minmax(13rem,2.2fr)_repeat(4,minmax(6.5rem,1fr))] md:items-center md:gap-x-3'

// A subtle blurred outline around the whole row in the zone's colour — drawn
// OUTSIDE the row (box-shadow), so it never covers or blurs the text and never
// catches a click. Unknown stays neutral. The colour is never the only signal:
// the row also says it in words (zoneCue).
const GLOW: Record<string, string> = {
  red: 'border-red-300 shadow-[0_0_0_1px_rgb(220_38_38/0.35),0_0_14px_1px_rgb(220_38_38/0.30)]',
  amber: 'border-amber-300 shadow-[0_0_0_1px_rgb(217_119_6/0.30),0_0_14px_1px_rgb(217_119_6/0.28)]',
  green: 'border-emerald-300 shadow-[0_0_0_1px_rgb(5_150_105/0.28),0_0_14px_1px_rgb(5_150_105/0.25)]',
  grey: 'border-slate-200 shadow-sm',
}
const CUE: Record<string, string> = {
  red: 'text-red-800',
  amber: 'text-amber-900',
  green: 'text-emerald-800',
  grey: 'text-slate-600',
}

// One label per cell for the stacked (phone) layout; on wider screens the
// header row names the columns, and screen readers get them from the table.
function Cell({ label, children, testId, missing = false }: { label: string; children: React.ReactNode; testId?: string; missing?: boolean }) {
  return (
    <div role="cell" className="flex items-baseline justify-between gap-2 py-0.5 md:block md:py-0">
      <span aria-hidden="true" className="text-[0.68rem] font-medium tracking-wide text-slate-500 uppercase md:hidden">
        {label}
      </span>
      <span className={`min-w-0 text-right font-mono text-sm break-words md:text-left ${missing ? 'text-slate-500' : 'font-semibold text-slate-900'}`} data-testid={testId}>
        {children}
      </span>
    </div>
  )
}

// Unknown is shown as unknown — never as zero, and zero is never "unknown".
function Unknown({ said }: { said: string }) {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{said}</span>
    </>
  )
}

export function SpecRow({
  spec,
  memberNames,
  actorId,
  canMeasure,
  canAdministerSpecs,
  canManageEvidence,
  onRecord,
  expanded,
  onToggle,
  tutorialId,
}: {
  spec: SpecVerdict
  memberNames: ReadonlyMap<string, string>
  actorId: string | null
  canMeasure: boolean
  canAdministerSpecs: boolean
  // Competition results and readiness: President, Vice President, Developer, or the authority of the
  // requirement's department. Presentation only; the database decides.
  canManageEvidence: boolean
  onRecord: (input: RecordMeasurement) => Promise<unknown>
  expanded: boolean
  onToggle: () => void
  tutorialId?: string
}) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const specId = spec.id as string
  const measuredBy = spec.measured_by ? memberNames.get(spec.measured_by) : undefined
  const zone = spec.zone ?? 'grey'
  const cue = zoneCue(spec.zone)
  const measuredMissing = spec.measured === null && spec.measured_bool === null
  const ideal = idealCell(spec)
  const regulatory = regulatoryLimitText(spec)
  const detailsId = `spec-details-${specId}`
  const competition = competitionCell(spec)

  return (
    <div
      role="rowgroup"
      className={`rounded-lg border bg-white ${GLOW[zone] ?? GLOW.grey}`}
      data-testid={`spec-${specId}`}
      data-verdict={spec.verdict ?? ''}
      data-zone={spec.zone ?? ''}
      data-tutorial={tutorialId}
    >
      <div role="row" className={`px-3 py-2 ${SPEC_COLUMNS}`}>
        <div role="rowheader" className="min-w-0 pb-1 md:pb-0">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={onToggle}
            className="group -mx-1 inline-flex min-h-11 max-w-full items-start gap-1.5 rounded px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 md:min-h-0"
            data-testid={`spec-toggle-${specId}`}
          >
            <span aria-hidden="true" className={`mt-0.5 inline-block text-xs text-slate-500 transition-transform ${expanded ? 'rotate-90' : ''}`}>
              ▸
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-slate-900 group-hover:underline">{spec.parameter}</span>
              <span className="block text-xs font-normal text-slate-600">{spec.unit ? `in ${spec.unit}` : 'no unit'}</span>
            </span>
          </button>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-xs">
            <span className={`inline-flex items-center gap-1 font-medium ${CUE[zone] ?? CUE.grey}`} data-testid={`zone-cue-${specId}`}>
              <span aria-hidden="true">{cue.icon}</span>
              {cue.label}
            </span>
            {spec.clause_key && (
              <Link
                to={`/register?search=${encodeURIComponent(spec.clause_key)}`}
                className="inline-flex min-h-6 items-center font-mono text-slate-500 underline underline-offset-2 hover:text-slate-800"
                data-testid={`spec-rule-${specId}`}
              >
                {spec.clause_key}
              </Link>
            )}
          </div>
        </div>
        <Cell label="Current (ours)" testId={`comparison-current-${specId}`} missing={measuredMissing}>
          {measuredMissing ? <Unknown said="Not measured" /> : measurementValue(spec.measured, spec.measured_bool, spec.unit)}
        </Cell>
        <Cell label="Ideal" testId={`comparison-ideal-${specId}`} missing={ideal === null}>
          {ideal === null ? (
            <Unknown said="Not set" />
          ) : (
            <>
              {ideal.value}
              {ideal.note && <span className="block font-sans text-[0.68rem] font-normal text-slate-500">{ideal.note}</span>}
            </>
          )}
        </Cell>
        <Cell label="Regulatory limit" testId={`comparison-regulatory-${specId}`} missing={regulatory === null}>
          {regulatory ?? 'Rule incomplete'}
        </Cell>
        <Cell label="Competition" testId={`competition-${specId}`} missing={competition === null}>
          {competition === null ? (
            <Unknown said="No competition data" />
          ) : (
            <>
              {competition.value}
              {competition.verdict && <span className="block font-sans text-[0.68rem] font-normal text-slate-500">{competition.verdict}</span>}
            </>
          )}
        </Cell>
      </div>

      {expanded && (
        <div role="row">
          <div role="cell" id={detailsId} className="border-t border-slate-200 px-3 pt-3 pb-3" data-testid={`spec-details-${specId}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 text-xs text-slate-600">
                {spec.condition && <p>{spec.condition}</p>}
                {spec.current_measurement_id !== null && (
                  <p className="mt-0.5" data-testid={`measured-by-${specId}`}>
                    Current observation by {measuredBy ?? 'Unknown member'}
                    {spec.measured_at ? ` · measured ${formatInstant(spec.measured_at)}` : ' · measured time unknown'}
                  </p>
                )}
              </div>
              <SpecStatuses spec={spec} />
            </div>
            <div className="mt-3">
              <SpecThresholds spec={spec} />
            </div>

            <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(18rem,0.8fr)_minmax(28rem,1.2fr)] xl:items-start">
              <div className="space-y-3">
                {canMeasure ? (
                  <MeasurementEditor spec={spec} onRecord={onRecord} />
                ) : (
                  <section className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                    Read-only: only active members can record observations.
                  </section>
                )}
                <ReadinessPanel spec={spec} canManage={canManageEvidence} memberNames={memberNames} />
                <DirectionPanel spec={spec} canReview={canAdministerSpecs} memberNames={memberNames} />
                {canManageEvidence ? (
                  <MeasurementEditor spec={spec} onRecord={onRecord} context="competition" />
                ) : (
                  <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600" data-testid={`competition-readonly-${specId}`}>
                    Competition results are recorded by the President, Vice President or the authority of the requirement’s department.
                  </p>
                )}
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-xs font-semibold tracking-wide text-slate-700 uppercase">Progression</h3>
                    <p className="mt-0.5 text-xs text-slate-600">Accepted observations, corrections and withdrawals.</p>
                  </div>
                  <button
                    type="button"
                    className={buttonSecondary}
                    aria-expanded={historyOpen}
                    aria-controls={`spec-history-${specId}`}
                    onClick={() => setHistoryOpen((open) => !open)}
                  >
                    {historyOpen ? 'Hide history' : 'Show history'}
                  </button>
                </div>
                {historyOpen && (
                  <div id={`spec-history-${specId}`} className="mt-3">
                    <SpecHistory spec={spec} memberNames={memberNames} actorId={actorId} canAdministerSpecs={canAdministerSpecs} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
