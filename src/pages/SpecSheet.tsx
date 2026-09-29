import { useMemo } from 'react'
import { useAuth } from '../auth/context.ts'
import { usePermissions } from '../auth/usePermissions.ts'
import { useMembers } from '../data/useMembers.ts'
import { useRealtimeSpecs } from '../data/useRealtimeSpecs.ts'
import { useRecordMeasurement, useSpecs } from '../data/useSpecs.ts'
import { mergeSearchParams, readSetParam, writeSetParam } from '../lib/searchParams.ts'
import { pageMain } from '../ui/layout.ts'
import { PageHeader } from '../ui/PageHeader.tsx'
import { ErrorState, LoadingState } from '../ui/states.tsx'
import { SPEC_COLUMNS, SpecRow } from './specSheet/SpecRow.tsx'
import { useUrlParams } from '../lib/useUrlParams.ts'

const HEADERS = ['Parameter / unit', 'Current (ours)', 'Ideal', 'Regulatory limit', 'Competition']

// Page orchestrator only. SQL remains the owner of every regulatory verdict,
// goal status and danger zone; the child components format those returned
// answers and own their small pieces of local interaction state.
export default function SpecSheet() {
  const specs = useSpecs()
  const realtime = useRealtimeSpecs()
  const members = useMembers()
  const record = useRecordMeasurement()
  const auth = useAuth()
  const permissions = usePermissions()

  const memberNames = useMemo(
    () => new Map((members.data ?? []).map((member) => [member.id, member.full_name])),
    [members.data],
  )
  const actorId = auth.status === 'member' && auth.member.status === 'active' ? auth.member.id : null
  // Which rows are open lives in the address (?open=a,b), so a link or a
  // refresh opens the same rows and other parameters are kept.
  const [params, setParams] = useUrlParams()
  const open = readSetParam(params, 'open', 100)
  const toggle = (id: string) => {
    const next = new Set(open)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setParams((current) => mergeSearchParams(current, { open: writeSetParam(next) }), { replace: true })
  }

  const error = specs.error ?? members.error
  if (error) {
    return (
      <main id="main-content" tabIndex={-1} className={pageMain('wide')}>
        <h1 className="text-xl font-semibold text-slate-900">Spec sheet</h1>
        <div className="mt-4">
          <ErrorState
            title="Could not load the spec sheet"
            error={error}
            onRetry={() => {
              void specs.refetch()
              void members.refetch()
            }}
          />
        </div>
      </main>
    )
  }

  const rows = specs.data ?? []
  const failing = rows.filter((spec) => spec.verdict === 'fail').length
  const incomplete = rows.filter((spec) => spec.verdict === 'unevaluable').length
  const measured = rows.filter((spec) => spec.current_measurement_id !== null).length

  return (
    <main id="main-content" tabIndex={-1} className={pageMain('wide')}>
      <PageHeader
        title="Spec sheet"
        description="Compare current engineering observations with project targets and regulatory limits. Verdicts and zones come from the database rules."
      >
        <p className="mt-1 text-xs text-slate-500">
          <span data-testid="specs-realtime-state" title="Live updates from other people editing">
            Live updates: {realtime}
          </span>
        </p>
      </PageHeader>

      <p className="mb-3 text-sm text-slate-600" data-testid="spec-summary" data-tutorial="spec-summary">
        {measured} of {rows.length} measured
        {failing > 0 && <span className="ml-2 font-semibold text-red-700">· <span aria-hidden="true">✕ </span>{failing} failing</span>}
        {incomplete > 0 && <span className="ml-2 text-slate-700">· <span aria-hidden="true">? </span>{incomplete} with an incomplete rule</span>}
      </p>

      {specs.isLoading && <LoadingState label="Loading specifications…" />}

      {!specs.isLoading && rows.length === 0 && (
        <p className="rounded border border-slate-200 bg-slate-50 p-6 text-center text-slate-600">
          No measurable rules for this season yet.
        </p>
      )}

      {rows.length > 0 && (
        <>
          <div role="table" aria-label="Specifications" aria-describedby="spec-table-notes" className="space-y-3" data-testid="spec-table">
            <div role="rowgroup" className="sr-only md:not-sr-only">
              <div role="row" className={`px-3 pb-1 text-[0.68rem] font-medium tracking-wide text-slate-500 uppercase ${SPEC_COLUMNS}`}>
                {HEADERS.map((header) => (
                  <div key={header} role="columnheader">
                    {header}
                  </div>
                ))}
              </div>
            </div>
            {rows.map((spec, index) => (
              <SpecRow
                key={spec.id}
                tutorialId={index === 0 ? 'spec-row' : undefined}
                spec={spec}
                memberNames={memberNames}
                actorId={actorId}
                canMeasure={actorId !== null}
                canAdministerSpecs={permissions.canEditSpecTargets}
                onRecord={record.mutateAsync}
                expanded={open.has(spec.id as string)}
                onToggle={() => toggle(spec.id as string)}
              />
            ))}
          </div>
          <div id="spec-table-notes" className="mt-4 space-y-1 text-xs text-slate-600">
            <p>
              The outline colour follows the database's zone: red fails the regulatory rule, amber passes it but misses the
              project goal, green passes and meets the goal, no colour means it cannot be judged yet. It describes our own
              measurement only — it is not scrutineering approval.
            </p>
            <p data-testid="competition-note">
              Competition: Reqon records no other team's measurements, so this column has nothing to show. It is a place for
              that data, not a comparison.
            </p>
            <p>Open a row to record a measurement, see the acceptable threshold and goal, and its history.</p>
          </div>
        </>
      )}
    </main>
  )
}
