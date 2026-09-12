import { useId, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import {
  useCreateMeeting,
  useUpdateMeeting,
  type Meeting,
  type MeetingDraft,
} from '../data/useMeetings.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { ActionError } from '../ui/states.tsx'

// Calling a meeting, or editing one that has happened.
//
// Two fields are required because the database requires them: a title and a
// date. Everything else is optional — the club regularly fixes the day before
// the hour, the room, or who turned up, and an invented value is worse than an
// empty one.
//
// Only administrators reach this (meeting_insert / meeting_update call
// is_admin()); a vice-president may write any meeting's agenda and minutes
// here, which is deliberately NOT the same as editing the global template.

type Errors = { title?: string; heldOn?: string; endsAt?: string }

export function MeetingDialog({
  open,
  meeting,
  template,
  onClose,
  onSaved,
}: {
  open: boolean
  // null = a new meeting, prefilled from the club's template.
  meeting: Meeting | null
  template: string
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const titleId = useId()
  const create = useCreateMeeting()
  const update = useUpdateMeeting()
  const pending = create.isPending || update.isPending
  const error = create.error ?? update.error

  const close = () => {
    create.reset()
    update.reset()
    onClose()
  }

  return (
    <Dialog open={open} onClose={close} labelledBy={titleId} dismissible={!pending}>
      <Form
        // Remounted per meeting, so reopening never shows the previous one's
        // half-typed values.
        key={meeting?.id ?? 'new'}
        meeting={meeting}
        template={template}
        titleId={titleId}
        pending={pending}
        error={error}
        onCancel={close}
        onSubmit={async (draft) => {
          try {
            if (meeting) {
              await update.mutateAsync({ id: meeting.id, ...draft })
              onSaved('Meeting updated.')
            } else {
              await create.mutateAsync(draft)
              onSaved('Meeting added.')
            }
          } catch {
            // Shown by ActionError; the dialog stays open with what was typed.
          }
        }}
      />
    </Dialog>
  )
}

function Form({
  meeting,
  template,
  titleId,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  meeting: Meeting | null
  template: string
  titleId: string
  pending: boolean
  error: Error | null
  onCancel: () => void
  onSubmit: (draft: MeetingDraft) => void
}) {
  const [title, setTitle] = useState(meeting?.title ?? '')
  const [heldOn, setHeldOn] = useState(meeting?.held_on ?? '')
  // Postgres `time` comes back as HH:MM:SS; a time input wants HH:MM.
  const [startsAt, setStartsAt] = useState((meeting?.starts_at ?? '').slice(0, 5))
  const [endsAt, setEndsAt] = useState((meeting?.ends_at ?? '').slice(0, 5))
  const [location, setLocation] = useState(meeting?.location ?? '')
  const [agenda, setAgenda] = useState(meeting ? (meeting.agenda ?? '') : template)
  const [notes, setNotes] = useState(meeting?.notes ?? '')
  const [attendees, setAttendees] = useState(meeting?.attendees ?? '')
  const [errors, setErrors] = useState<Errors>({})
  const fieldId = (name: string) => `${titleId}-${name}`

  function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return

    const found: Errors = {}
    if (title.trim() === '') found.title = 'Give the meeting a name.'
    if (heldOn === '') found.heldOn = 'A meeting needs a date.'
    // The database checks this too (meetings_ends_after_starts).
    if (endsAt !== '' && startsAt !== '' && endsAt <= startsAt) {
      found.endsAt = 'The end must be after the start.'
    }

    const firstBad = found.title ? 'title' : found.heldOn ? 'held-on' : found.endsAt ? 'ends-at' : null
    if (firstBad) {
      // Render the messages before moving focus, or focus lands on a field
      // whose error has not been painted yet.
      flushSync(() => setErrors(found))
      document.getElementById(fieldId(firstBad))?.focus()
      return
    }

    setErrors({})
    onSubmit({
      title: title.trim(),
      heldOn,
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      location: location.trim() || null,
      agenda: agenda.trim() || null,
      notes: notes.trim() || null,
      attendees: attendees.trim() || null,
    })
  }

  const field =
    'mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'
  const label = 'block text-xs font-medium text-slate-600'

  return (
    <form onSubmit={submit} noValidate>
      <h2 id={titleId} className="text-base font-semibold text-balance text-slate-900">
        {meeting ? 'Edit meeting' : 'New meeting'}
      </h2>

      <fieldset className="mt-3 grid gap-3" disabled={pending}>
        <legend className="sr-only">Meeting details</legend>

        <div>
          <label className={label} htmlFor={fieldId('title')}>
            Name
          </label>
          <input
            id={fieldId('title')}
            name="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? fieldId('title-error') : undefined}
            placeholder="Weekly build meeting"
            className={field}
          />
          {errors.title && (
            <p id={fieldId('title-error')} className="mt-1 text-xs text-red-700">
              {errors.title}
            </p>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className={label} htmlFor={fieldId('held-on')}>
              Date
            </label>
            <input
              id={fieldId('held-on')}
              name="held_on"
              type="date"
              value={heldOn}
              onChange={(e) => setHeldOn(e.target.value)}
              aria-invalid={errors.heldOn ? true : undefined}
              aria-describedby={errors.heldOn ? fieldId('held-on-error') : undefined}
              className={field}
            />
            {errors.heldOn && (
              <p id={fieldId('held-on-error')} className="mt-1 text-xs text-red-700">
                {errors.heldOn}
              </p>
            )}
          </div>
          <div>
            <label className={label} htmlFor={fieldId('starts-at')}>
              Starts (optional)
            </label>
            <input
              id={fieldId('starts-at')}
              name="starts_at"
              type="time"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className={field}
            />
          </div>
          <div>
            <label className={label} htmlFor={fieldId('ends-at')}>
              Ends (optional)
            </label>
            <input
              id={fieldId('ends-at')}
              name="ends_at"
              type="time"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              aria-invalid={errors.endsAt ? true : undefined}
              aria-describedby={errors.endsAt ? fieldId('ends-at-error') : undefined}
              className={field}
            />
            {errors.endsAt && (
              <p id={fieldId('ends-at-error')} className="mt-1 text-xs text-red-700">
                {errors.endsAt}
              </p>
            )}
          </div>
        </div>

        <div>
          <label className={label} htmlFor={fieldId('location')}>
            Where (optional)
          </label>
          <input
            id={fieldId('location')}
            name="location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Workshop, or a link"
            className={field}
          />
        </div>

        <div>
          <label className={label} htmlFor={fieldId('agenda')}>
            Agenda
          </label>
          <textarea
            id={fieldId('agenda')}
            name="agenda"
            rows={8}
            value={agenda}
            onChange={(e) => setAgenda(e.target.value)}
            className={`${field} min-h-0 font-mono text-xs`}
          />
          {!meeting && (
            <p className="mt-1 text-xs text-slate-500">
              Started from the club&apos;s template. Change it here for this meeting only.
            </p>
          )}
        </div>

        <div>
          <label className={label} htmlFor={fieldId('notes')}>
            Minutes (optional)
          </label>
          <textarea
            id={fieldId('notes')}
            name="notes"
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What was decided, and who took what away."
            className={`${field} min-h-0`}
          />
        </div>

        <div>
          <label className={label} htmlFor={fieldId('attendees')}>
            Who came (optional)
          </label>
          <input
            id={fieldId('attendees')}
            name="attendees"
            value={attendees}
            onChange={(e) => setAttendees(e.target.value)}
            placeholder="Names, as free text"
            className={field}
          />
        </div>
      </fieldset>

      <ActionError error={error} className="mt-3" />

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" className={buttonSecondary} disabled={pending} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={buttonPrimary} disabled={pending}>
          {pending ? 'Saving…' : meeting ? 'Save changes' : 'Add meeting'}
        </button>
      </div>
    </form>
  )
}
