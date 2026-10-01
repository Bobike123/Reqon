import { useMemo, useState, type FormEvent } from 'react'
import {
  useCorrectMeasurement,
  useInvalidateMeasurement,
  useSpecMeasurements,
  type SpecMeasurement,
  type SpecVerdict,
} from '../../data/useSpecs.ts'
import { formatInstant } from '../../lib/dates.ts'
import { measurementValue, projectGoalText, regulatoryLimitText } from '../../specs/presentation.ts'
import { newRequestId, parseMeasurementInput, validatePlausibility } from '../../specs/measurementInput.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import { buttonDanger, buttonPrimary, buttonSecondary } from '../../ui/buttons.ts'
import { ActionError, ErrorState, LoadingState } from '../../ui/states.tsx'

type Action = { mode: 'correct' | 'withdraw'; row: SpecMeasurement }
const EMPTY_HISTORY: SpecMeasurement[] = []

function actorName(id: string | null, names: ReadonlyMap<string, string>): string {
  if (id === null) return 'Unknown (legacy observation)'
  return names.get(id) ?? 'Unknown member'
}

function measuredTime(row: SpecMeasurement): string {
  return row.measured_at ? formatInstant(row.measured_at) : 'Measured time unknown'
}

type ReferenceLine = { value: number; label: string; kind: 'goal' | 'regulatory' }

function referenceLines(spec: SpecVerdict): ReferenceLine[] {
  const lines: ReferenceLine[] = []
  if (spec.direction === 'range') {
    if (spec.goal !== null) lines.push({ value: spec.goal, label: 'Project goal minimum', kind: 'goal' })
    if (spec.goal_max !== null) lines.push({ value: spec.goal_max, label: 'Project goal maximum', kind: 'goal' })
  } else if (spec.direction !== 'boolean' && spec.goal !== null) {
    lines.push({ value: spec.goal, label: 'Project goal', kind: 'goal' })
  }

  if (spec.comparator === 'range') {
    if (spec.target !== null) lines.push({ value: spec.target, label: 'Regulatory minimum', kind: 'regulatory' })
    if (spec.target_max !== null) lines.push({ value: spec.target_max, label: 'Regulatory maximum', kind: 'regulatory' })
  } else if (spec.comparator !== 'bool' && spec.target !== null) {
    lines.push({ value: spec.target, label: 'Regulatory limit', kind: 'regulatory' })
  }
  return lines
}

function TrendChart({ spec, rows }: { spec: SpecVerdict; rows: SpecMeasurement[] }) {
  // Our own progression only: a competition result is a different fact and is listed in the table, never drawn
  // as a point on the team's trend.
  const accepted = rows
    .filter((row) => row.invalidated_at === null && row.value_numeric !== null && row.context !== 'competition')
    .slice()
    .reverse()
  if (spec.measure_kind === 'boolean' || accepted.length < 2) return null

  const values = accepted.map((row) => row.value_numeric as number)
  const references = referenceLines(spec)
  const domain = [...values, ...references.map((line) => line.value)]
  let minimum = Math.min(...domain)
  let maximum = Math.max(...domain)
  if (minimum === maximum) {
    minimum -= 1
    maximum += 1
  }

  const width = 640
  const height = 190
  const left = 42
  const right = 18
  const top = 24
  const bottom = 32
  const innerWidth = width - left - right
  const innerHeight = height - top - bottom
  const x = (index: number) => left + (innerWidth * index) / (accepted.length - 1)
  const y = (value: number) => top + ((maximum - value) / (maximum - minimum)) * innerHeight
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(' ')
  const progression = values.map(String).join(' → ')
  const unit = spec.unit ? ` ${spec.unit}` : ''

  return (
    <figure className="rounded-md border border-slate-200 bg-white p-2" data-testid={`trend-${spec.id}`}>
      <figcaption className="text-xs font-semibold text-slate-700">Accepted numeric progression</figcaption>
      <p className="mt-0.5 overflow-x-auto whitespace-nowrap font-mono text-sm text-slate-900" data-testid={`progression-${spec.id}`}>
        {progression}{unit}
      </p>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-2 h-auto w-full min-w-0"
        role="img"
        aria-labelledby={`trend-title-${spec.id} trend-desc-${spec.id}`}
        data-values={values.join(',')}
      >
        <title id={`trend-title-${spec.id}`}>{spec.parameter} accepted measurement trend</title>
        <desc id={`trend-desc-${spec.id}`}>
          {progression}{unit}. Dashed lines are labelled project goals and regulatory limits.
        </desc>
        {references.map((line, index) => {
          const lineY = y(line.value)
          return (
            <g key={`${line.kind}-${line.label}-${line.value}-${index}`}>
              <line
                x1={left}
                x2={width - right}
                y1={lineY}
                y2={lineY}
                stroke={line.kind === 'goal' ? '#0f766e' : '#b45309'}
                strokeDasharray={line.kind === 'goal' ? '7 4' : '2 4'}
                strokeWidth="1.5"
              />
              <text x={left + 3} y={Math.max(11, lineY - 4)} className="fill-slate-700 text-[10px]">
                {line.label}: {line.value}{unit}
              </text>
            </g>
          )
        })}
        <line x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} stroke="#cbd5e1" />
        <polyline points={points} fill="none" stroke="#0f172a" strokeWidth="2.5" />
        {accepted.map((row, index) => (
          <g key={row.id}>
            <circle cx={x(index)} cy={y(row.value_numeric as number)} r="4" fill="#fff" stroke="#0f172a" strokeWidth="2" />
            <text x={x(index)} y={height - 12} textAnchor="middle" className="fill-slate-600 text-[10px]">
              {index + 1}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  )
}

function MeasurementActionDialog({
  action,
  spec,
  onClose,
}: {
  action: Action
  spec: SpecVerdict
  onClose: () => void
}) {
  const correct = useCorrectMeasurement()
  const invalidate = useInvalidateMeasurement()
  const [reason, setReason] = useState('')
  const [text, setText] = useState(() =>
    action.row.value_bool !== null ? (action.row.value_bool ? 'true' : 'false') : String(action.row.value_numeric ?? ''),
  )
  const [inputError, setInputError] = useState<string | null>(null)
  const [requestId] = useState(newRequestId)
  const pending = correct.isPending || invalidate.isPending
  const error = correct.error ?? invalidate.error
  const headingId = `measurement-action-${action.row.id}`

  async function submit(event: FormEvent) {
    event.preventDefault()
    const why = reason.trim()
    if (!why) {
      setInputError('Explain why this observation is being changed.')
      return
    }
    setInputError(null)
    try {
      if (action.mode === 'withdraw') {
        await invalidate.mutateAsync({ measurementId: action.row.id, reason: why })
      } else {
        const parsed = parseMeasurementInput(text, spec.measure_kind === 'boolean' ? 'boolean' : 'numeric')
        if (!parsed.ok) {
          setInputError(parsed.message)
          return
        }
        if (typeof parsed.value === 'number') {
          const plausibilityError = validatePlausibility(
            parsed.value,
            spec.plausible_min,
            spec.plausible_max,
            spec.unit,
          )
          if (plausibilityError) {
            setInputError(plausibilityError)
            return
          }
        }
        await correct.mutateAsync({ measurementId: action.row.id, reason: why, value: parsed.value, requestId })
      }
      onClose()
    } catch {
      // The hook's translated error stays visible; the reason, value and
      // correction request id remain intact for a safe retry.
    }
  }

  return (
    <Dialog open onClose={onClose} labelledBy={headingId} dismissible={!pending}>
      <form onSubmit={(event) => void submit(event)}>
        <h2 id={headingId} className="text-lg font-semibold text-slate-900">
          {action.mode === 'correct' ? 'Correct observation' : 'Withdraw observation'}
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Original: {measurementValue(action.row.value_numeric, action.row.value_bool, spec.unit)}. The original record stays in history.
        </p>

        {action.mode === 'correct' && (
          <label className="mt-3 block text-sm font-medium text-slate-700">
            Corrected value{spec.measure_kind !== 'boolean' && spec.unit ? ` (${spec.unit})` : ''}
            {spec.measure_kind === 'boolean' ? (
              <select
                value={text}
                onChange={(event) => setText(event.target.value)}
                className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm sm:min-h-0"
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : (
              <input
                type="number"
                inputMode="decimal"
                step="any"
                value={text}
                onChange={(event) => setText(event.target.value)}
                className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm sm:min-h-0"
              />
            )}
          </label>
        )}

        <label className="mt-3 block text-sm font-medium text-slate-700">
          Reason <span className="text-red-700">(required)</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            maxLength={500}
            className="mt-1 min-h-20 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        {inputError && <p role="alert" className="mt-2 text-sm text-red-700"><span aria-hidden="true">✕ </span>{inputError}</p>}
        <ActionError error={error} className="mt-2" />
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={buttonSecondary}>Cancel</button>
          <button
            type="submit"
            disabled={pending || reason.trim() === ''}
            className={action.mode === 'correct' ? buttonPrimary : buttonDanger}
          >
            {pending ? 'Saving…' : action.mode === 'correct' ? 'Save correction' : 'Withdraw observation'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function SpecHistory({
  spec,
  memberNames,
  actorId,
  canAdministerSpecs,
}: {
  spec: SpecVerdict
  memberNames: ReadonlyMap<string, string>
  actorId: string | null
  canAdministerSpecs: boolean
}) {
  const history = useSpecMeasurements(spec.id ?? undefined)
  const [action, setAction] = useState<Action | null>(null)
  const rows = history.data?.rows ?? EMPTY_HISTORY
  const correctedBy = useMemo(() => {
    const map = new Map<string, SpecMeasurement>()
    for (const row of rows) if (row.corrects_id) map.set(row.corrects_id, row)
    return map
  }, [rows])

  if (history.isLoading) return <LoadingState label="Loading observation history…" />
  if (history.error) {
    return <ErrorState title="Could not load observation history" error={history.error} onRetry={() => void history.refetch()} />
  }

  return (
    <section aria-labelledby={`history-heading-${spec.id}`} className="space-y-3">
      <div>
        <h3 id={`history-heading-${spec.id}`} className="text-sm font-semibold text-slate-900">Observation history</h3>
        <p className="text-xs text-slate-600">
          Newest measured time first. Corrections and withdrawals keep the original record.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="rounded border border-slate-200 bg-white p-3 text-sm text-slate-600">No observations recorded yet.</p>
      ) : (
        <>
          <TrendChart spec={spec} rows={rows} />
          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="min-w-[48rem] w-full border-collapse text-left text-xs" data-testid={`history-table-${spec.id}`}>
              <caption className="sr-only">
                Text alternative for {spec.parameter} progression. Project goal {projectGoalText(spec) ?? 'not set'};
                regulatory limit {regulatoryLimitText(spec) ?? 'rule incomplete'}.
              </caption>
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-2 py-2 font-medium">Measured</th>
                  <th className="px-2 py-2 font-medium">Value</th>
                  <th className="px-2 py-2 font-medium">Measured by</th>
                  <th className="px-2 py-2 font-medium">Details</th>
                  <th className="px-2 py-2 font-medium">Record state</th>
                  <th className="px-2 py-2 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {rows.map((row) => {
                  const replacement = correctedBy.get(row.id)
                  const canChange = row.invalidated_at === null && (canAdministerSpecs || row.measured_by === actorId)
                  return (
                    <tr key={row.id} className={row.invalidated_at ? 'bg-slate-50 text-slate-500' : 'text-slate-800'} data-testid={`measurement-${row.id}`}>
                      <td className="whitespace-nowrap px-2 py-2 align-top">
                        {measuredTime(row)}
                        <span className="mt-0.5 block text-[0.68rem] text-slate-500">Recorded {formatInstant(row.recorded_at)}</span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 align-top font-mono font-medium">
                        {measurementValue(row.value_numeric, row.value_bool, spec.unit)}
                        {spec.current_measurement_id === row.id && <span className="ml-1 font-sans text-emerald-800">Current</span>}
                      </td>
                      <td className="px-2 py-2 align-top">{actorName(row.measured_by, memberNames)}</td>
                      <td className="max-w-64 px-2 py-2 align-top">
                        {row.note && <span className="block">{row.note}</span>}
                        {row.source && <span className="block text-slate-500">Source: {row.source}</span>}
                        {!row.note && !row.source && <span className="text-slate-400">—</span>}
                      </td>
                      <td className="max-w-72 px-2 py-2 align-top">
                        {row.context === 'competition' && <span className="block font-medium" data-testid={`history-context-${row.id}`}>Competition result (kept apart from ours)</span>}
                        {row.origin === 'correction' && <span className="block font-medium">Correction of an earlier observation</span>}
                        {row.origin === 'legacy_import' && <span className="block">Imported legacy current value</span>}
                        {row.invalidated_at ? (
                          <span className="block text-red-800">
                            <span aria-hidden="true">✕ </span>{replacement ? 'Replaced by a correction' : 'Withdrawn'}: {row.invalidation_reason}
                            {row.invalidated_by && <> by {actorName(row.invalidated_by, memberNames)}</>}
                            {row.invalidated_at && <> on {formatInstant(row.invalidated_at)}</>}
                          </span>
                        ) : (
                          <span className="text-emerald-800"><span aria-hidden="true">● </span>Accepted</span>
                        )}
                      </td>
                      <td className="px-2 py-2 align-top">
                        {canChange && (
                          <div className="flex flex-wrap justify-end gap-1">
                            <button type="button" className={buttonSecondary} onClick={() => setAction({ mode: 'correct', row })}>
                              Correct
                            </button>
                            <button type="button" className={buttonSecondary} onClick={() => setAction({ mode: 'withdraw', row })}>
                              Withdraw
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {history.hasNextPage && (
        <button type="button" className={buttonSecondary} disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
          {history.isFetchingNextPage ? 'Loading…' : 'Load older observations'}
        </button>
      )}

      {action && <MeasurementActionDialog key={`${action.mode}-${action.row.id}`} action={action} spec={spec} onClose={() => setAction(null)} />}
    </section>
  )
}
