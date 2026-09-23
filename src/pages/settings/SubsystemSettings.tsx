import { useMembers } from '../../data/useMembers.ts'
import { useSubteams, useUpdateSubteam } from '../../data/useSubteams.ts'
import { ActionError, ErrorState } from '../../ui/states.tsx'

// Subsystem names, descriptions and leads. Admin-only, so the route shell
// never renders this section for anyone else (Phase 6 §6.1).
export function SubsystemSettings() {
  const subteams = useSubteams()
  const members = useMembers()
  const updateSubteam = useUpdateSubteam()

  const readError = subteams.error ?? members.error

  return (
    <>
      {readError && (
        <ErrorState
          title="Could not load subsystems"
          error={readError}
          onRetry={() => {
            void subteams.refetch()
            void members.refetch()
          }}
        />
      )}
      <ActionError error={updateSubteam.error} className="mb-2" />
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {(subteams.data ?? []).map((s) => (
          <li key={s.key} className="px-3 py-2" data-testid={`subteam-row-${s.key}`}>
            <span className="font-mono text-xs text-slate-500">{s.key}</span>
            <div className="mt-1 flex flex-wrap gap-2">
              <label className="sr-only" htmlFor={`sub-name-${s.key}`}>Name for {s.key}</label>
              <input
                id={`sub-name-${s.key}`}
                defaultValue={s.name}
                onBlur={(e) => {
                  if (e.target.value !== s.name) updateSubteam.mutate({ key: s.key, name: e.target.value })
                }}
                className="min-h-11 flex-1 rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
              />
              <label className="sr-only" htmlFor={`sub-lead-${s.key}`}>Lead for {s.key}</label>
              <select
                id={`sub-lead-${s.key}`}
                value={s.lead_id ?? ''}
                onChange={(e) => updateSubteam.mutate({ key: s.key, leadId: e.target.value || null })}
                className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
              >
                <option value="">No lead</option>
                {(members.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>{m.full_name}</option>
                ))}
              </select>
            </div>
            <label className="sr-only" htmlFor={`sub-desc-${s.key}`}>Description for {s.key}</label>
            <input
              id={`sub-desc-${s.key}`}
              defaultValue={s.description ?? ''}
              placeholder="What this subsystem covers"
              onBlur={(e) => {
                if (e.target.value !== (s.description ?? '')) {
                  updateSubteam.mutate({ key: s.key, description: e.target.value || null })
                }
              }}
              className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            />
          </li>
        ))}
      </ul>
    </>
  )
}
