import { useState } from 'react'
import { useSetMilestoneSubmission } from '../../data/useMilestones.ts'
import { formatDay, todayIso } from '../../lib/dates.ts'
import type { Milestone } from '../../milestones/types.ts'
import { buttonPrimary, buttonSecondary } from '../../ui/buttons.ts'
import { ActionError } from '../../ui/states.tsx'
import { milestoneLabel } from '../../milestones/label.ts'

// A milestone's WORK, its SUBMISSION and its ACCEPTANCE are three different facts. The bar above this is
// work (linked tasks done). Submitted and accepted are dates a person records — never inferred from the
// bar, and never set by finishing tasks. Until someone records them they read "Not recorded".
export function SubmissionState({
  milestone,
  canRecord,
  memberNames,
  workLabel,
}: {
  milestone: Milestone
  canRecord: boolean
  memberNames: ReadonlyMap<string, string>
  // e.g. "3 of 4 tasks done", or "No linked work": what the bar says, repeated here so the three sit together.
  workLabel: string
}) {
  const save = useSetMilestoneSubmission()
  const key = milestone.key
  const [editing, setEditing] = useState(false)
  const [submitted, setSubmitted] = useState(milestone.submitted_on ?? '')
  const [accepted, setAccepted] = useState(milestone.accepted_on ?? '')
  // What the form started from: if someone else records a change while it is open, saving would overwrite
  // their dates, so the form says so and waits for the person to reload the values.
  const [baseline, setBaseline] = useState({ submitted: milestone.submitted_on ?? '', accepted: milestone.accepted_on ?? '' })
  const today = todayIso()
  const changedElsewhere =
    editing && ((milestone.submitted_on ?? '') !== baseline.submitted || (milestone.accepted_on ?? '') !== baseline.accepted)
  const close = () => {
    setEditing(false)
    requestAnimationFrame(() => document.getElementById(`submission-edit-${key}`)?.focus())
  }

  const who = (id: string | null) => (id ? (memberNames.get(id) ?? 'someone no longer on the roster') : null)
  const submittedBy = who(milestone.submitted_by)
  const acceptedBy = who(milestone.accepted_by)
  const load = () => {
    setSubmitted(milestone.submitted_on ?? '')
    setAccepted(milestone.accepted_on ?? '')
    setBaseline({ submitted: milestone.submitted_on ?? '', accepted: milestone.accepted_on ?? '' })
  }
  const open = () => {
    load()
    setEditing(true)
  }
  const problem =
    accepted !== '' && submitted === ''
      ? 'It cannot be accepted before it was submitted.'
      : accepted !== '' && accepted < submitted
        ? 'The acceptance date cannot be before the submission date.'
        : (submitted !== '' && submitted > today) || (accepted !== '' && accepted > today)
          ? 'A date in the future cannot be recorded as something that already happened.'
          : null

  return (
    <div className="mt-1 text-xs" data-testid={`submission-${key}`}>
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-slate-700">
        <div className="flex gap-1">
          <dt className="font-medium">Work:</dt>
          <dd data-testid={`work-${key}`}>{workLabel}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="font-medium">Submitted:</dt>
          <dd data-testid={`submitted-${key}`}>
            {milestone.submitted_on ? `${formatDay(milestone.submitted_on)}${submittedBy ? ` · ${submittedBy}` : ''}` : <span className="text-slate-500">Not recorded</span>}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="font-medium">Accepted:</dt>
          <dd data-testid={`accepted-${key}`}>
            {milestone.accepted_on ? `${formatDay(milestone.accepted_on)}${acceptedBy ? ` · ${acceptedBy}` : ''}` : <span className="text-slate-500">Not recorded</span>}
          </dd>
        </div>
      </dl>

      {canRecord && !editing && (
        <button id={`submission-edit-${key}`} type="button" className={`${buttonSecondary} mt-1`} onClick={open} data-testid={`submission-edit-${key}`}>
          Record submission…
        </button>
      )}
      {canRecord && editing && (
        <form
          className="mt-1 flex flex-wrap items-end gap-2 rounded border border-slate-200 bg-white p-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (problem || changedElsewhere) return
            save.mutate(
              { key, submittedOn: submitted || null, acceptedOn: accepted || null },
              { onSuccess: close },
            )
          }}
        >
          <div>
            <label className="block font-medium text-slate-700" htmlFor={`submitted-on-${key}`}>
              Submitted on
            </label>
            <input id={`submitted-on-${key}`} autoFocus type="date" max={today} value={submitted} onChange={(e) => setSubmitted(e.target.value)}
              className="mt-0.5 min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-sm sm:min-h-0" />
          </div>
          <div>
            <label className="block font-medium text-slate-700" htmlFor={`accepted-on-${key}`}>
              Accepted on
            </label>
            <input id={`accepted-on-${key}`} type="date" max={today} value={accepted} onChange={(e) => setAccepted(e.target.value)}
              className="mt-0.5 min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-sm sm:min-h-0" />
          </div>
          <button type="submit" className={buttonPrimary} disabled={problem !== null || changedElsewhere || save.isPending}>
            {save.isPending ? 'Saving…' : `Save record for ${milestoneLabel(milestone)}`}
          </button>
          <button type="button" className={buttonSecondary} onClick={close}>
            Cancel
          </button>
          {changedElsewhere && (
            <p role="alert" className="basis-full text-amber-900" data-testid={`submission-changed-${key}`}>
              Someone else changed these dates while you were editing.{' '}
              <button type="button" className="underline" onClick={load}>
                Show their dates
              </button>
            </p>
          )}
          {problem && <p role="alert" className="basis-full text-red-700" data-testid={`submission-problem-${key}`}>{problem}</p>}
          <p className="basis-full text-slate-500">Clear a date to correct a mistake; every change is kept in the activity history.</p>
        </form>
      )}
      <ActionError error={save.error} className="mt-1" />
    </div>
  )
}
