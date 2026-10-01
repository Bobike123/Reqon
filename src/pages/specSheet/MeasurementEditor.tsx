import { useRef, useState } from 'react'
import type { RecordMeasurement, SpecVerdict } from '../../data/useSpecs.ts'
import {
  newRequestId,
  parseMeasurementInput,
  validatePlausibility,
  type MeasureKind,
} from '../../specs/measurementInput.ts'
import { buttonPrimary, buttonQuiet, buttonSecondary } from '../../ui/buttons.ts'

type Pending = { value: number | boolean; requestId: string }

function currentAsInput(spec: SpecVerdict, context: 'team' | 'competition'): string {
  if (context === 'competition') {
    if (spec.competition_value_bool !== null && spec.competition_value_bool !== undefined) return spec.competition_value_bool ? 'true' : 'false'
    return spec.competition_value === null || spec.competition_value === undefined ? '' : String(spec.competition_value)
  }
  if (spec.measured_bool !== null) return spec.measured_bool ? 'true' : 'false'
  return spec.measured === null ? '' : String(spec.measured)
}

export function MeasurementEditor({
  spec,
  onRecord,
  context = 'team',
}: {
  spec: SpecVerdict
  onRecord: (input: RecordMeasurement) => Promise<unknown>
  // 'team' is our own observation. 'competition' is a result read at the event: it is kept apart, never
  // becomes Current (ours), and the server lets only evidence authority record it.
  context?: 'team' | 'competition'
}) {
  const kind: MeasureKind = spec.measure_kind === 'boolean' ? 'boolean' : 'numeric'
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [source, setSource] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [inputError, setInputError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [draftBaseId, setDraftBaseId] = useState<string | null | undefined>(undefined)
  const savingRef = useRef(false)

  const specId = spec.id as string
  const competition = context === 'competition'
  // The observation this draft would sit next to; when someone else's arrives meanwhile the person is told.
  const currentId = competition ? (spec.competition_measurement_id ?? null) : spec.current_measurement_id
  const suffix = competition ? '-competition' : ''
  const hasDraft = text.trim() !== '' || pending !== null
  const hasIncomingCurrent = hasDraft && draftBaseId !== undefined && draftBaseId !== currentId

  function updateText(next: string) {
    if (next.trim() === '') setDraftBaseId(undefined)
    else if (draftBaseId === undefined) setDraftBaseId(currentId)
    setText(next)
    setInputError(null)
    setSaveError(null)
  }

  function review() {
    setSaveError(null)
    const parsed = parseMeasurementInput(text, kind)
    if (!parsed.ok) {
      setInputError(parsed.message)
      setPending(null)
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
        setPending(null)
        return
      }
    }
    setInputError(null)
    setPending({ value: parsed.value, requestId: newRequestId() })
  }

  function cancelReview() {
    setPending(null)
    setSaveError(null)
  }

  function discardDraft() {
    setText('')
    setNote('')
    setSource('')
    setPending(null)
    setInputError(null)
    setSaveError(null)
    setDraftBaseId(undefined)
  }

  function replaceWithCurrent() {
    const current = currentAsInput(spec, context)
    setText(current)
    setPending(null)
    setInputError(null)
    setSaveError(null)
    setDraftBaseId(current === '' ? undefined : currentId)
  }

  async function confirm() {
    if (!pending || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      await onRecord({
        specId,
        value: pending.value,
        requestId: pending.requestId,
        context,
        unit: spec.unit,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(source.trim() ? { source: source.trim() } : {}),
      })
      discardDraft()
    } catch (error) {
      // Keep the draft and request id. Retrying is the same logical save, so
      // the command returns the first row if the response alone was lost.
      setSaveError(error instanceof Error ? error.message : 'Could not save that measurement.')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const unit = spec.unit ? ` ${spec.unit}` : ''

  return (
    <section aria-labelledby={`measure-heading-${specId}${suffix}`} className="rounded-md border border-slate-200 bg-slate-50 p-3" data-testid={`measurement-editor-${specId}${suffix}`}>
      <h3 id={`measure-heading-${specId}${suffix}`} className="text-xs font-semibold tracking-wide text-slate-700 uppercase">
        {competition ? 'Record a competition result' : 'Add an observation'}
      </h3>
      {competition && (
        <p className="mt-0.5 text-xs text-slate-600">
          A value read at the event. It is kept apart from our own measurements: it never becomes Current (ours) and does not change readiness.
        </p>
      )}

      {hasIncomingCurrent && (
        <div
          role="status"
          className="mt-2 rounded border border-sky-300 bg-sky-50 p-2 text-xs text-sky-950"
          data-testid={`realtime-conflict-${specId}${suffix}`}
        >
          <p className="font-semibold">Current changed while you were entering this observation.</p>
          <p className="mt-0.5">Your draft is unchanged. Review the new Current above, then keep, replace or discard your draft.</p>
          <div className="mt-2 flex flex-wrap gap-1">
            <button type="button" className={buttonSecondary} onClick={() => setDraftBaseId(currentId)}>
              Keep my draft
            </button>
            <button type="button" className={buttonSecondary} onClick={replaceWithCurrent}>
              Replace with Current
            </button>
            <button type="button" className={buttonQuiet} onClick={discardDraft}>
              Discard draft
            </button>
          </div>
        </div>
      )}

      {pending === null ? (
        <div className="mt-2">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-xs text-slate-600" htmlFor={`measured-${specId}${suffix}`}>
                New measurement{kind === 'numeric' && spec.unit ? ` (${spec.unit})` : ''}
              </label>
              {kind === 'boolean' ? (
                <select
                  id={`measured-${specId}${suffix}`}
                  value={text}
                  onChange={(event) => updateText(event.target.value)}
                  className="mt-1 min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                >
                  <option value="">—</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : (
                <input
                  id={`measured-${specId}${suffix}`}
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={text}
                  placeholder="—"
                  onChange={(event) => updateText(event.target.value)}
                  className="mt-1 min-h-11 w-32 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                />
              )}
            </div>
            <button type="button" onClick={review} disabled={text.trim() === ''} className={buttonSecondary}>
              Review
            </button>
          </div>

          <details className="mt-2 text-xs text-slate-600">
            <summary className="cursor-pointer select-none font-medium">Optional note and source</summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label>
                Note
                <textarea
                  value={note}
                  maxLength={1000}
                  onChange={(event) => setNote(event.target.value)}
                  className="mt-1 min-h-16 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
                />
              </label>
              <label>
                Source
                <input
                  value={source}
                  maxLength={300}
                  onChange={(event) => setSource(event.target.value)}
                  className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 sm:min-h-0"
                />
              </label>
            </div>
          </details>
        </div>
      ) : (
        <div
          role="group"
          aria-label={`Confirm measurement for ${spec.parameter}`}
          className="mt-2 rounded border border-slate-300 bg-white p-2"
          data-testid={`confirm-${specId}${suffix}`}
        >
          <p className="text-sm text-slate-900">
            Record{' '}
            <span className="font-mono font-semibold">
              {typeof pending.value === 'boolean' ? (pending.value ? 'Yes' : 'No') : `${pending.value}${unit}`}
            </span>{' '}
            for {spec.parameter}?
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            This adds one history entry. Regulatory and project statuses are recalculated by the server after save.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => void confirm()} disabled={saving} className={buttonPrimary}>
              {saving ? 'Saving…' : competition ? 'Save competition result' : 'Save measurement'}
            </button>
            <button type="button" onClick={cancelReview} disabled={saving} className={buttonSecondary}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {inputError && (
        <p role="alert" className="mt-2 text-xs font-medium text-red-700" data-testid={`input-error-${specId}${suffix}`}>
          <span aria-hidden="true">✕ </span>{inputError}
        </p>
      )}
      {saveError && (
        <p role="alert" className="mt-2 text-xs font-medium text-red-700" data-testid={`save-error-${specId}${suffix}`}>
          <span aria-hidden="true">✕ </span>Could not save that measurement: {saveError}
        </p>
      )}
    </section>
  )
}
