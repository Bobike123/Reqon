import { PageHeader } from '../ui/PageHeader.tsx'
import { formatDay } from '../lib/dates.ts'
import { pageMain } from '../ui/layout.ts'
import { ErrorState } from '../ui/states.tsx'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMembers } from '../data/useMembers.ts'
import { useSetMeasurement, useSpecs, type SpecVerdict } from '../data/useSpecs.ts'

// Pass / fail is NEVER computed here.
//
// `verdict` arrives from the spec_verdicts view, which derives it in SQL from
// the rule's own comparator and target. That is the whole point: the rule is
// the source of truth, and a stored or client-computed verdict goes stale the
// moment a target changes. If you are tempted to write `measured > target`
// anywhere in this file, stop — the database already answered.
function VerdictBadge({ verdict }: { verdict: string | null }) {
  if (verdict === 'fail') {
    return (
      <span
        className="rounded bg-red-700 px-2 py-0.5 text-xs font-bold tracking-wide text-white"
        data-testid="verdict-fail"
      >
        FAILS RULE
      </span>
    )
  }
  if (verdict === 'pass') {
    return (
      <span className="rounded bg-green-700 px-2 py-0.5 text-xs font-bold tracking-wide text-white">
        PASS
      </span>
    )
  }
  // Anything else — including a value the rule cannot judge, such as the
  // 'range' comparator — is honestly reported as not measured. Never a pass.
  return (
    <span
      className="rounded bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700"
      data-testid="verdict-unmeasured"
    >
      not measured
    </span>
  )
}

function targetText(spec: SpecVerdict): string {
  if (spec.target_text) return spec.target_text
  const op = spec.comparator === 'min' ? '≥' : spec.comparator === 'max' ? '≤' : '='
  return `${op} ${spec.target ?? '?'}${spec.unit ? ` ${spec.unit}` : ''}`
}

function SpecRow({
  spec,
  measuredByName,
  onSave,
  saving,
  tutorialId,
}: {
  tutorialId?: string
  spec: SpecVerdict
  measuredByName?: string
  onSave: (id: string, measured: number | null) => void
  saving: boolean
}) {
  const serverValue = spec.measured === null ? '' : String(spec.measured)
  const [value, setValue] = useState(serverValue)
  const [lastSeen, setLastSeen] = useState(serverValue)
  if (lastSeen !== serverValue) {
    setLastSeen(serverValue)
    setValue(serverValue)
  }

  const failed = spec.verdict === 'fail'

  return (
    <li
      // On a wide screen the measurement box sits at the right-hand end.
      className={`border-b border-slate-200 px-3 py-2.5 lg:flex lg:items-start lg:justify-between lg:gap-6 ${failed ? 'bg-red-50' : ''}`}
      data-testid={`spec-${spec.id}`}
      data-verdict={spec.verdict ?? ''}
      data-tutorial={tutorialId}
    >
      <div className="min-w-0 lg:flex-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium text-slate-900">{spec.parameter}</span>
        <VerdictBadge verdict={spec.verdict} />
        <span className="font-mono text-xs text-slate-600">{targetText(spec)}</span>
        {/* The rule this number comes from — already in the data, so a failing
            measurement always names the clause you have to argue with. */}
        {spec.clause_key && (
          <Link
            to={`/register?search=${encodeURIComponent(spec.clause_key)}`}
            className="inline-flex min-h-6 items-center font-mono text-xs text-slate-500 underline hover:text-slate-800"
            data-testid={`spec-rule-${spec.id}`}
          >
            {spec.clause_key}
          </Link>
        )}
      </div>

      {spec.condition && <p className="mt-0.5 text-xs text-slate-600">{spec.condition}</p>}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 lg:mt-0 lg:shrink-0">
        <label className="text-xs text-slate-600" htmlFor={`measured-${spec.id}`}>
          Measured{spec.unit ? ` (${spec.unit})` : ''}
        </label>
        <input
          id={`measured-${spec.id}`}
          type="number"
          inputMode="decimal"
          step="any"
          value={value}
          disabled={saving}
          placeholder="—"
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => {
            if (value === serverValue) return
            const trimmed = value.trim()
            // An empty box clears the measurement. It must never read as a pass.
            onSave(spec.id as string, trimmed === '' ? null : Number(trimmed))
          }}
          className="min-h-11 w-28 rounded border border-slate-300 px-2 py-1 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
        />
        {spec.measured !== null && (
          <span className="text-xs text-slate-500" data-testid={`measured-by-${spec.id}`}>
            by {measuredByName ?? 'unknown'}
            {spec.measured_at ? ` on ${formatDay(spec.measured_at)}` : ''}
          </span>
        )}
      </div>
    </li>
  )
}

export default function SpecSheet() {
  const specs = useSpecs()
  const members = useMembers()
  const setMeasurement = useSetMeasurement()

  const memberNames = new Map((members.data ?? []).map((m) => [m.id, m.full_name]))

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
  const failing = rows.filter((s) => s.verdict === 'fail').length
  const measured = rows.filter((s) => s.measured !== null).length

  return (
    <main id="main-content" tabIndex={-1} className={pageMain('wide')}>
      <PageHeader
        title="Spec sheet"
        description="Measured values checked against the regulation limits. The verdict comes from the rule, never typed in."
      />

      <p className="mb-3 text-sm text-slate-600" data-testid="spec-summary" data-tutorial="spec-summary">
        {measured} of {rows.length} measured
        {failing > 0 && (
          <span className="ml-2 font-semibold text-red-700">· {failing} failing</span>
        )}
      </p>

      {specs.isLoading && <p role="status" className="text-xs text-slate-500">Loading…</p>}
      {setMeasurement.isError && (
        <p role="alert" className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          Could not save that measurement: {setMeasurement.error.message}
        </p>
      )}
      {setMeasurement.isPending && (
        <p role="status" className="mb-3 text-xs text-slate-500">Saving…</p>
      )}

      {!specs.isLoading && rows.length === 0 && (
        <p className="rounded border border-slate-200 bg-slate-50 p-6 text-center text-slate-600">
          No measurable rules for this season yet.
        </p>
      )}

      <ul className="rounded-lg border border-slate-200 bg-white">
        {rows.map((spec, index) => (
          <SpecRow
            key={spec.id}
            tutorialId={index === 0 ? 'spec-row' : undefined}
            spec={spec}
            measuredByName={spec.measured_by ? memberNames.get(spec.measured_by) : undefined}
            saving={setMeasurement.isPending}
            onSave={(id, value) => setMeasurement.mutate({ id, measured: value })}
          />
        ))}
      </ul>
    </main>
  )
}
