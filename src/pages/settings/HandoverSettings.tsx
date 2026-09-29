import { useAuth } from '../../auth/context.ts'
import { useHandoverNotes, useSetHandoverNote } from '../../data/useHandoverNotes.ts'
import { useSubteams } from '../../data/useSubteams.ts'
import { ActionError, ErrorState } from '../../ui/states.tsx'

// One handover note per subsystem, open to everyone — the one section every
// signed-in member sees regardless of role.
export function HandoverSettings() {
  const auth = useAuth()
  const myId = auth.status === 'member' ? auth.member.id : null
  const subteams = useSubteams()
  const notes = useHandoverNotes()
  const setNote = useSetHandoverNote()

  const readError = subteams.error ?? notes.error

  return (
    <>
      {readError && (
        <ErrorState
          title="Could not load handover notes"
          error={readError}
          onRetry={() => {
            void subteams.refetch()
            void notes.refetch()
          }}
        />
      )}
      <ActionError error={setNote.error} className="mb-2" />
      <p className="mb-2 text-xs text-slate-500">
        One note per department, for whoever picks this up next year. Saved when you
        click away.
      </p>
      <ul className="space-y-2">
        {(subteams.data ?? []).map((s) => {
          const note = (notes.data ?? []).find((n) => n.subteam_key === s.key)
          return (
            <li key={s.key} className="rounded-lg border border-slate-200 bg-white p-3">
              <label className="block text-xs font-medium text-slate-700" htmlFor={`note-${s.key}`}>
                {s.name}
              </label>
              <textarea
                id={`note-${s.key}`}
                aria-labelledby={undefined}
                rows={2}
                defaultValue={note?.body ?? ''}
                placeholder="What the next person needs to know…"
                onBlur={(e) => {
                  if (!myId) return
                  if (e.target.value !== (note?.body ?? '')) {
                    setNote.mutate({ subteamKey: s.key, body: e.target.value, memberId: myId })
                  }
                }}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
              />
            </li>
          )
        })}
      </ul>
    </>
  )
}
