import { useMilestones, useUpdateMilestone } from '../../data/useMilestones.ts'
import { ActionError, ErrorState } from '../../ui/states.tsx'

// Milestone submission windows and points, for a new edition. Admin-only.
export function MilestoneSettings() {
  const milestones = useMilestones()
  const updateMilestone = useUpdateMilestone()

  return (
    <>
      {milestones.error && (
        <ErrorState title="Could not load milestones" error={milestones.error} onRetry={() => void milestones.refetch()} />
      )}
      <ActionError error={updateMilestone.error} className="mb-2" />
      <p className="mb-2 text-xs text-slate-500">
        For a new edition. Leaving a due date blank is valid — it renders as TBC.
      </p>
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {(milestones.data ?? []).map((m) => (
          <li key={m.key} className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid={`ms-row-${m.key}`}>
            <span className="w-32 shrink-0 text-sm text-slate-900">
              <span className="font-mono text-xs">{m.key}</span> {m.name}
            </span>
            <label className="sr-only" htmlFor={`ms-opens-${m.key}`}>Opens on for {m.key}</label>
            <input
              id={`ms-opens-${m.key}`} type="date" defaultValue={m.opens_on ?? ''}
              onBlur={(e) => {
                if (e.target.value !== (m.opens_on ?? '')) {
                  updateMilestone.mutate({ key: m.key, opensOn: e.target.value || null })
                }
              }}
              className="min-h-11 rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            />
            <label className="sr-only" htmlFor={`ms-due-${m.key}`}>Due on for {m.key}</label>
            <input
              id={`ms-due-${m.key}`} type="date" defaultValue={m.due_on ?? ''}
              onBlur={(e) => {
                if (e.target.value !== (m.due_on ?? '')) {
                  updateMilestone.mutate({ key: m.key, dueOn: e.target.value || null })
                }
              }}
              className="min-h-11 rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            />
            <label className="sr-only" htmlFor={`ms-points-${m.key}`}>Max points for {m.key}</label>
            <input
              id={`ms-points-${m.key}`} type="number" min={0} defaultValue={m.max_points}
              onBlur={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n) && n !== m.max_points) {
                  updateMilestone.mutate({ key: m.key, maxPoints: n })
                }
              }}
              className="min-h-11 w-20 rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            />
          </li>
        ))}
      </ul>
    </>
  )
}
