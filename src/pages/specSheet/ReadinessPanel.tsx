import { useState } from 'react'
import { useConfirmReadiness, useRevokeReadiness, useReviewDirection, type SpecVerdict } from '../../data/useSpecs.ts'
import { formatInstantDay } from '../../lib/dates.ts'
import { measurementValue, readinessPresentation } from '../../specs/presentation.ts'
import { buttonPrimary, buttonSecondary } from '../../ui/buttons.ts'
import { ActionError } from '../../ui/states.tsx'

const AREA =
  'w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500'

// "Checked and ready" is a person's confirmation of ONE exact current team measurement, with a note of
// what was checked. Passing the rule or meeting a goal confirms nothing. The confirmation ends by itself
// when that measurement is replaced, corrected or withdrawn, or when the rule or targets change — the
// database does that; this panel only reads the answer (spec_verdicts.readiness) and offers the two commands.
export function ReadinessPanel({
  spec,
  canManage,
  memberNames,
}: {
  spec: SpecVerdict
  canManage: boolean
  memberNames: ReadonlyMap<string, string>
}) {
  const specId = spec.id as string
  const confirm = useConfirmReadiness()
  const revoke = useRevokeReadiness()
  const [withdrawing, setWithdrawing] = useState(false)
  const [reason, setReason] = useState('')

  const view = readinessPresentation(spec, formatInstantDay)
  const by = spec.readiness_confirmed_by ? (memberNames.get(spec.readiness_confirmed_by) ?? 'Someone no longer on the roster') : null
  const measurementId = spec.current_measurement_id
  const canConfirmNow = canManage && view.state !== 'ready' && spec.verdict === 'pass' && measurementId !== null
  const error = confirm.error ?? revoke.error
  // The form closes by itself if the confirmation lapsed elsewhere while it was open.
  const showWithdraw = withdrawing && view.state === 'ready'
  const closeWithdraw = () => {
    setWithdrawing(false)
    setReason('')
    requestAnimationFrame(() => document.getElementById(`withdraw-open-${specId}`)?.focus())
  }

  return (
    <section
      aria-labelledby={`readiness-heading-${specId}`}
      className="rounded-md border border-slate-200 bg-slate-50 p-3"
      data-testid={`readiness-${specId}`}
      data-readiness={spec.readiness ?? ''}
    >
      <h3 id={`readiness-heading-${specId}`} className="text-xs font-semibold tracking-wide text-slate-700 uppercase">
        Readiness
      </h3>
      <p className="mt-1 text-sm font-medium text-slate-900" data-testid={`readiness-state-${specId}`}>
        {view.label}
        {by ? <span className="font-normal text-slate-600"> · {by}</span> : null}
      </p>
      {view.detail && (
        <p className="mt-0.5 text-xs text-slate-700" data-testid={`readiness-detail-${specId}`}>
          {view.state === 'ready' ? `“${view.detail}”` : view.detail}
        </p>
      )}
      <p className="mt-1 text-xs text-slate-600">
        Passing the rule or meeting a goal does not make a specification ready — a person confirms the current
        measurement. A newer measurement, a correction or withdrawal, or a change to the rule or targets ends the confirmation.
      </p>

      {view.state === 'ready' && canManage && !showWithdraw && (
        <button id={`withdraw-open-${specId}`} type="button" className={`${buttonSecondary} mt-2`} onClick={() => setWithdrawing(true)}>
          Withdraw confirmation…
        </button>
      )}
      {showWithdraw && (
        <form
          className="mt-2 space-y-1"
          onSubmit={(e) => {
            e.preventDefault()
            if (reason.trim() === '') return
            revoke.mutate({ specId, reason: reason.trim() }, { onSuccess: closeWithdraw })
          }}
        >
          <label className="block text-xs font-medium text-slate-700" htmlFor={`withdraw-reason-${specId}`}>
            Why is it being withdrawn?
          </label>
          <textarea id={`withdraw-reason-${specId}`} autoFocus rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className={AREA} />
          <div className="flex gap-2">
            <button type="submit" className={buttonPrimary} disabled={reason.trim() === '' || revoke.isPending}>
              {revoke.isPending ? 'Withdrawing…' : 'Withdraw confirmation'}
            </button>
            <button type="button" className={buttonSecondary} onClick={closeWithdraw}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {canConfirmNow && measurementId !== null && (
        // Keyed by the measurement: if the current one changes while a note is being typed, the form starts over
        // instead of confirming a note written for a different measurement.
        <ConfirmForm
          key={measurementId}
          specId={specId}
          measurementId={measurementId}
          valueText={measurementValue(spec.measured, spec.measured_bool, spec.unit)}
          measuredAt={spec.measured_at}
          pending={confirm.isPending}
          onConfirm={(note, done) => confirm.mutate({ specId, measurementId, note }, { onSuccess: done })}
        />
      )}
      {!canConfirmNow && view.state !== 'ready' && (
        <p className="mt-2 text-xs text-slate-600" data-testid={`readiness-why-not-${specId}`}>
          {!canManage
            ? 'The President, Vice President or the authority of the requirement’s department confirms readiness.'
            : spec.verdict !== 'pass'
              ? 'Only a current measurement that passes the rule can be confirmed ready.'
              : 'There is no current measurement to confirm.'}
        </p>
      )}
      <ActionError error={error} className="mt-2" />
    </section>
  )
}

function ConfirmForm({
  specId,
  measurementId,
  valueText,
  measuredAt,
  pending,
  onConfirm,
}: {
  specId: string
  measurementId: string
  valueText: string
  measuredAt: string | null
  pending: boolean
  // `done` runs only when the command succeeded, so a refused confirmation keeps what was typed.
  onConfirm: (note: string, done: () => void) => void
}) {
  const [note, setNote] = useState('')
  return (
    <form
      className="mt-3 space-y-1 border-t border-slate-200 pt-2"
      data-measurement={measurementId}
      onSubmit={(e) => {
        e.preventDefault()
        if (note.trim() === '') return
        onConfirm(note.trim(), () => setNote(''))
      }}
    >
      <p className="text-xs text-slate-700" role="status">
        Confirm that the current measurement, <span className="font-mono font-semibold">{valueText}</span>
        {measuredAt ? ` (measured ${formatInstantDay(measuredAt)})` : ''}, is ready.
      </p>
      <label className="block text-xs font-medium text-slate-700" htmlFor={`confirm-note-${specId}`}>
        What was checked?
      </label>
      <textarea id={`confirm-note-${specId}`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={AREA} />
      <button type="submit" className={buttonPrimary} disabled={note.trim() === '' || pending} data-testid={`confirm-ready-${specId}`}>
        {pending ? 'Confirming…' : 'Confirm ready'}
      </button>
    </form>
  )
}

// Which way is better for the project. Derived from the regulatory minimum/maximum until a person confirms
// it: a floor set by the rules can still mean "lighter is better" for the design.
export function DirectionPanel({
  spec,
  canReview,
  memberNames,
}: {
  spec: SpecVerdict
  canReview: boolean
  memberNames: ReadonlyMap<string, string>
}) {
  const specId = spec.id as string
  const review = useReviewDirection()
  // No preselected answer: the derived direction is what is being questioned, so the choice must be deliberate.
  const [direction, setDirection] = useState<'' | 'higher_better' | 'lower_better'>('')
  const [note, setNote] = useState('')

  if (spec.direction !== 'higher_better' && spec.direction !== 'lower_better') return null

  const reviewer = spec.direction_reviewed_by ? (memberNames.get(spec.direction_reviewed_by) ?? 'Someone no longer on the roster') : null
  return (
    <section
      aria-labelledby={`direction-heading-${specId}`}
      className="rounded-md border border-slate-200 bg-slate-50 p-3"
      data-testid={`direction-review-${specId}`}
      data-needs-review={spec.direction_needs_review ? 'true' : 'false'}
    >
      <h3 id={`direction-heading-${specId}`} className="text-xs font-semibold tracking-wide text-slate-700 uppercase">
        Which way is better
      </h3>
      {spec.direction_needs_review ? (
        <>
          <p className="mt-1 text-sm text-amber-950" data-testid={`direction-unreviewed-${specId}`}>
            Not reviewed. “{spec.direction === 'lower_better' ? 'Lower' : 'Higher'} is better” was only derived from the rule’s minimum or
            maximum. Until a person confirms it, acceptable, goal and ideal values cannot be set and no goal is scored.
          </p>
          {canReview ? (
            <form
              className="mt-2 space-y-1"
              onSubmit={(e) => {
                e.preventDefault()
                if (note.trim() === '' || direction === '') return
                review.mutate({ specId, direction, note: note.trim() }, { onSuccess: () => setNote('') })
              }}
            >
              <label className="block text-xs font-medium text-slate-700" htmlFor={`direction-choice-${specId}`}>
                For the project, which is better?
              </label>
              <select
                id={`direction-choice-${specId}`}
                value={direction}
                onChange={(e) => setDirection(e.target.value as '' | 'higher_better' | 'lower_better')}
                className={AREA}
              >
                <option value="">Choose…</option>
                <option value="higher_better">Higher is better</option>
                <option value="lower_better">Lower is better</option>
              </select>
              <label className="block text-xs font-medium text-slate-700" htmlFor={`direction-note-${specId}`}>
                The engineering reason
              </label>
              <textarea id={`direction-note-${specId}`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={AREA} />
              <button type="submit" className={buttonPrimary} disabled={note.trim() === '' || direction === '' || review.isPending}>
                {review.isPending ? 'Saving…' : 'Confirm direction'}
              </button>
            </form>
          ) : (
            <p className="mt-1 text-xs text-slate-600">The President or Vice President reviews it.</p>
          )}
        </>
      ) : (
        <p className="mt-1 text-sm text-slate-800" data-testid={`direction-reviewed-${specId}`}>
          {spec.direction === 'lower_better' ? 'Lower is better' : 'Higher is better'}
          {reviewer ? ` · reviewed by ${reviewer}` : ''}
          {spec.direction_reviewed_at ? ` on ${formatInstantDay(spec.direction_reviewed_at)}` : ''}
          {spec.direction_note ? <span className="block text-xs text-slate-600">“{spec.direction_note}”</span> : null}
        </p>
      )}
      <ActionError error={review.error} className="mt-2" />
    </section>
  )
}
