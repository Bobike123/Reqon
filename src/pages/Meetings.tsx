import { useId, useState } from 'react'
import { usePermissions } from '../auth/usePermissions.ts'
import {
  useDeleteMeeting,
  useMeetingTemplate,
  useMeetings,
  useSaveMeetingTemplate,
  type Meeting,
} from '../data/useMeetings.ts'
import { formatDay } from '../lib/dates.ts'
import { MeetingDialog } from '../meetings/MeetingDialog.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { PageHeader } from '../ui/PageHeader.tsx'
import { buttonDanger, buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { pageMain } from '../ui/layout.ts'
import { ActionError, EmptyState, ErrorState, LoadingState } from '../ui/states.tsx'

// Real meetings: when the club met, where, what was on the agenda and what was
// decided. The screen that used to carry this name showed task proposals; those
// now live on their own screen.
//
// Who may do what comes from the database
// (20260108000000_proposals_and_meetings.sql): everyone on the roster reads,
// administrators create and edit, and only a president or developer deletes.

const time = (value: string | null) => (value ? value.slice(0, 5) : null)

function when(meeting: Meeting): string {
  const start = time(meeting.starts_at)
  const end = time(meeting.ends_at)
  const clock = start ? (end ? `${start}–${end}` : start) : null
  return clock ? `${formatDay(meeting.held_on)}, ${clock}` : formatDay(meeting.held_on)
}

export default function Meetings() {
  const can = usePermissions()
  const meetings = useMeetings()
  const template = useMeetingTemplate()
  const remove = useDeleteMeeting()
  const [editing, setEditing] = useState<Meeting | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Meeting | null>(null)
  const [message, setMessage] = useState('')
  const deleteTitleId = useId()

  const rows = meetings.data ?? []

  const closeDelete = () => {
    remove.reset()
    setDeleting(null)
  }
  async function confirmDelete(meeting: Meeting) {
    try {
      await remove.mutateAsync(meeting.id)
      setDeleting(null)
      setMessage('Meeting deleted.')
    } catch {
      // Shown in the dialog; nothing on screen changes.
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className={pageMain('wide')}>
      <PageHeader
        title="Meetings"
        description="When the club met, what was on the agenda, and what was decided."
      >
        <p className="mt-2 text-sm text-slate-700" data-testid="meeting-access">
          {can.canCreateMeeting
            ? 'You can call a meeting and write its agenda and minutes.'
            : 'Everyone can read these. The President, Vice President or a Developer calls a meeting.'}
        </p>
      </PageHeader>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">
          {rows.length === 1 ? '1 meeting' : `${rows.length} meetings`}
        </h2>
        {can.canCreateMeeting && (
          <button
            type="button"
            className={buttonPrimary}
            data-tutorial="meeting-new"
            onClick={() => {
              setMessage('')
              setEditing('new')
            }}
          >
            New meeting
          </button>
        )}
      </div>
      <p role="status" className="mt-1 min-h-5 text-sm text-emerald-800">
        {message}
      </p>

      <div className="mt-1" data-tutorial="meeting-list">
        {meetings.error ? (
          <ErrorState
            title="Could not load meetings"
            error={meetings.error}
            onRetry={() => void meetings.refetch()}
          />
        ) : meetings.isPending ? (
          <LoadingState label="Loading meetings…" />
        ) : rows.length === 0 ? (
          <EmptyState title="No meetings yet">
            {can.canCreateMeeting
              ? 'Call the first one with “New meeting”. It starts from the club’s agenda template.'
              : 'When the board calls a meeting, it appears here with its agenda and minutes.'}
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {rows.map((meeting) => (
              <li
                key={meeting.id}
                className="rounded-lg border border-slate-200 bg-white p-3"
                data-testid={`meeting-${meeting.id}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">{meeting.title}</h3>
                  <p className="text-sm text-slate-700">
                    <time dateTime={meeting.held_on}>{when(meeting)}</time>
                    {meeting.location ? ` · ${meeting.location}` : ''}
                  </p>
                </div>

                {meeting.agenda && (
                  <div className="mt-2">
                    <h4 className="text-xs font-medium text-slate-600">Agenda</h4>
                    <p className="mt-0.5 text-sm whitespace-pre-line text-slate-800">{meeting.agenda}</p>
                  </div>
                )}
                {meeting.notes && (
                  <div className="mt-2">
                    <h4 className="text-xs font-medium text-slate-600">Minutes</h4>
                    <p className="mt-0.5 text-sm whitespace-pre-line text-slate-800">{meeting.notes}</p>
                  </div>
                )}
                {meeting.attendees && (
                  <p className="mt-2 text-xs text-slate-600">Who came: {meeting.attendees}</p>
                )}

                {(can.canCreateMeeting || can.canDeleteMeeting) && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {can.canCreateMeeting && (
                      <button
                        type="button"
                        className={buttonSecondary}
                        aria-label={`Edit ${meeting.title}`}
                        onClick={() => {
                          setMessage('')
                          setEditing(meeting)
                        }}
                      >
                        Edit
                      </button>
                    )}
                    {can.canDeleteMeeting && (
                      <button
                        type="button"
                        className={buttonSecondary}
                        aria-label={`Delete ${meeting.title}`}
                        onClick={() => {
                          setMessage('')
                          setDeleting(meeting)
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* The global agenda template. Editing THIS is president or developer
          only; a vice-president still writes each meeting's own agenda above. */}
      {can.canEditMeetingTemplate && <TemplateEditor />}

      <MeetingDialog
        open={editing !== null}
        meeting={editing === 'new' ? null : editing}
        template={template.data ?? ''}
        onClose={() => setEditing(null)}
        onSaved={(text) => {
          setEditing(null)
          setMessage(text)
        }}
      />

      <Dialog
        open={deleting !== null}
        onClose={closeDelete}
        labelledBy={deleteTitleId}
        dismissible={!remove.isPending}
      >
        {deleting && (
          <div>
            <h2 id={deleteTitleId} className="text-base font-semibold text-balance text-slate-900">
              Delete this meeting?
            </h2>
            <p className="mt-2 text-sm text-pretty text-slate-700">
              “{deleting.title}” of {when(deleting)} will be removed for everyone, with its agenda
              and minutes. This cannot be undone.
            </p>
            <ActionError error={remove.error} className="mt-3" />
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                className={buttonSecondary}
                disabled={remove.isPending}
                onClick={closeDelete}
              >
                Cancel
              </button>
              <button
                type="button"
                className={buttonDanger}
                disabled={remove.isPending}
                onClick={() => void confirmDelete(deleting)}
              >
                {remove.isPending ? 'Deleting…' : 'Delete meeting'}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </main>
  )
}

// The default agenda every new meeting starts from. Separate from any one
// meeting's content on purpose: this is club configuration.
function TemplateEditor() {
  const template = useMeetingTemplate()
  const save = useSaveMeetingTemplate()
  const [body, setBody] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const id = useId()
  const value = body ?? template.data ?? ''

  return (
    <section className="mt-8" aria-labelledby={`${id}-heading`} data-tutorial="meeting-template">
      <h2 id={`${id}-heading`} className="text-sm font-semibold text-slate-900">
        Default agenda for new meetings
      </h2>
      <p className="mt-0.5 text-xs text-slate-600">
        Every new meeting starts from this. Changing it here changes nothing about meetings that
        already exist. Only the President and a Developer can edit it.
      </p>
      <label className="sr-only" htmlFor={`${id}-body`}>
        Default agenda template
      </label>
      <textarea
        id={`${id}-body`}
        rows={10}
        value={value}
        disabled={save.isPending || template.isPending}
        onChange={(e) => {
          setBody(e.target.value)
          setSaved(false)
        }}
        className="mt-2 w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-xs text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
      />
      <ActionError error={save.error} className="mt-2" />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          className={buttonSecondary}
          disabled={save.isPending || body === null}
          onClick={async () => {
            try {
              await save.mutateAsync(value)
              setBody(null)
              setSaved(true)
            } catch {
              // Shown by ActionError above.
            }
          }}
        >
          {save.isPending ? 'Saving…' : 'Save template'}
        </button>
        <p role="status" className="text-xs text-emerald-800">
          {saved ? 'Template saved.' : ''}
        </p>
      </div>
    </section>
  )
}
