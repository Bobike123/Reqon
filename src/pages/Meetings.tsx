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
import { MarkdownField } from '../meetings/MarkdownField.tsx'
import { MeetingDialog } from '../meetings/MeetingDialog.tsx'
import { MeetingText } from '../meetings/MeetingText.tsx'
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
            : 'Everyone can read these. The President or Vice President calls a meeting.'}
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
                    <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">Agenda</p>
                    <div className="mt-1">
                      <MeetingText text={meeting.agenda} testId={`meeting-agenda-${meeting.id}`} />
                    </div>
                  </div>
                )}
                {meeting.notes && (
                  <div className="mt-3 border-t border-slate-100 pt-2">
                    <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">Minutes</p>
                    <div className="mt-1">
                      <MeetingText text={meeting.notes} testId={`meeting-notes-${meeting.id}`} />
                    </div>
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
          only (template_write: can_delete_records()); a vice-president still
          writes each meeting's own agenda above. */}
      {(can.canCreateMeeting || can.canEditMeetingTemplate) && (
        <DefaultAgenda canEdit={can.canEditMeetingTemplate} onSaved={setMessage} />
      )}

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
// meeting's content on purpose: this is club configuration. Readable by
// whoever calls meetings; edited in a dialog by the President or a Developer.
//
// The draft lives here, outside the dialog, so closing the dialog by accident
// (Escape, a click outside) or a failed save never loses what was typed; only
// "Discard changes" or a successful save clears it.
function DefaultAgenda({ canEdit, onSaved }: { canEdit: boolean; onSaved: (message: string) => void }) {
  const template = useMeetingTemplate()
  const save = useSaveMeetingTemplate()
  const [open, setOpen] = useState(false)
  // The text being edited, and the saved text it started from.
  const [draft, setDraft] = useState<{ body: string; base: string } | null>(null)
  const id = useId()
  const current = template.data ?? ''
  const dirty = draft !== null && draft.body !== draft.base
  // Someone else saved a different default agenda after this draft began.
  const movedOn = draft !== null && template.data !== undefined && draft.base !== current

  const openEditor = () => {
    save.reset()
    if (draft === null) setDraft({ body: current, base: current })
    setOpen(true)
  }
  const discard = () => {
    setDraft(null)
    save.reset()
    setOpen(false)
  }
  async function submit() {
    if (!draft) return
    try {
      await save.mutateAsync(draft.body)
      setDraft(null)
      setOpen(false)
      onSaved('Default agenda saved. Meetings that already exist are unchanged.')
    } catch {
      // Shown in the dialog; the draft stays.
    }
  }

  return (
    <section className="mt-8 rounded-lg border border-slate-200 bg-white p-3" aria-labelledby={`${id}-heading`} data-tutorial="meeting-template">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={`${id}-heading`} className="text-sm font-semibold text-slate-900">
            Default agenda for new meetings
          </h2>
          <p className="mt-0.5 text-xs text-slate-600">
            Every new meeting starts from this. Changing it changes nothing about meetings that already exist.
            {canEdit ? '' : ' The President edits it.'}
          </p>
        </div>
        {canEdit && (
          <button type="button" className={buttonSecondary} onClick={openEditor} disabled={template.isPending} data-testid="template-edit">
            Edit default agenda
          </button>
        )}
      </div>
      {dirty && !open && (
        <p className="mt-2 text-xs text-amber-900" data-testid="template-draft-kept">
          You have unsaved changes to the default agenda. Open “Edit default agenda” to save or discard them.
        </p>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-slate-700 underline-offset-2 hover:underline">Show the default agenda</summary>
        <div className="mt-2 rounded border border-slate-100 bg-slate-50 p-2">
          {template.error ? (
            <ActionError error={template.error} />
          ) : template.isPending ? (
            <p className="text-sm text-slate-600">Loading…</p>
          ) : current.trim() ? (
            <MeetingText text={current} testId="template-view" />
          ) : (
            <p className="text-sm text-slate-600">The default agenda is empty.</p>
          )}
        </div>
      </details>

      <Dialog open={open} onClose={() => setOpen(false)} labelledBy={`${id}-dialog`} dismissible={!save.isPending}>
        {draft && (
          <div>
            <h2 id={`${id}-dialog`} className="text-base font-semibold text-balance text-slate-900">
              Edit default agenda
            </h2>
            {movedOn && (
              <p role="status" className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">
                Someone saved a different default agenda after you started. Saving replaces it with yours.{' '}
                <button type="button" className="underline underline-offset-2" onClick={() => setDraft({ body: current, base: current })}>
                  Start again from theirs
                </button>
              </p>
            )}
            <div className="mt-3">
              <MarkdownField
                id={`${id}-body`}
                label="Default agenda"
                value={draft.body}
                onChange={(body) => setDraft({ ...draft, body })}
                rows={12}
                disabled={save.isPending}
              />
            </div>
            <ActionError error={save.error} className="mt-3" />
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" className={buttonSecondary} disabled={save.isPending || !dirty} onClick={discard}>
                Discard changes
              </button>
              <button type="button" className={buttonSecondary} disabled={save.isPending} onClick={() => setOpen(false)}>
                Close
              </button>
              <button type="button" className={buttonPrimary} disabled={save.isPending || !dirty} onClick={() => void submit()}>
                {save.isPending ? 'Saving…' : 'Save default agenda'}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </section>
  )
}
