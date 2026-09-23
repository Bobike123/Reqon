import { useState, type FormEvent } from 'react'
import { useCreateSeason, useSeasons, useSetCurrentSeason } from '../../data/useSeasons.ts'
import { ActionError, ErrorState } from '../../ui/states.tsx'

// The season list, switching the current one, and starting a new one.
export function SeasonSettings({ canAdminister }: { canAdminister: boolean }) {
  const seasons = useSeasons()
  const createSeason = useCreateSeason()
  const setCurrent = useSetCurrentSeason()
  const [newSeason, setNewSeason] = useState({ label: '', edition: '' })

  async function submitSeason(e: FormEvent) {
    e.preventDefault()
    if (createSeason.isPending || !newSeason.label.trim()) return
    try {
      await createSeason.mutateAsync({ label: newSeason.label.trim(), edition: newSeason.edition.trim() || null })
      setNewSeason({ label: '', edition: '' })
    } catch {
      // Refused or failed: the message is shown, and what was typed stays.
    }
  }

  return (
    <>
      {seasons.error && (
        <ErrorState title="Could not load seasons" error={seasons.error} onRetry={() => void seasons.refetch()} />
      )}
      <ActionError error={createSeason.error ?? setCurrent.error} className="mb-2" />
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {(seasons.data ?? []).map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid={`season-${s.id}`}>
            <span className="text-sm text-slate-900">{s.label}</span>
            {s.is_current && (
              <span className="rounded bg-green-700 px-1.5 py-0.5 text-[11px] font-medium text-white" data-testid={`current-${s.id}`}>
                current
              </span>
            )}
            {canAdminister && !s.is_current && (
              <button
                type="button"
                disabled={setCurrent.isPending}
                onClick={() => setCurrent.mutate(s.id)}
                data-testid={`make-current-${s.id}`}
                className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
              >
                {setCurrent.isPending ? 'Switching…' : 'Make current'}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-slate-500">
        Switching runs in a single database transaction, so the club can never end up
        with two current seasons — or none. Old seasons stay readable.
      </p>

      {canAdminister && (
        <form onSubmit={submitSeason} className="mt-3 rounded-lg border border-slate-200 bg-white p-3" data-tutorial="new-season">
          <h3 className="text-sm font-medium text-slate-900">Start a new season</h3>
          <p className="mt-0.5 mb-2 text-xs text-slate-600">
            The new season starts empty: the rulebook carries over untouched, and none
            of this year&apos;s progress is copied. Nothing becomes current until you
            press “Make current”.
          </p>
          <label className="block text-xs font-medium text-slate-600" htmlFor="new-season-label">Label</label>
          <input
            id="new-season-label"
            value={newSeason.label}
            onChange={(e) => setNewSeason((s) => ({ ...s, label: e.target.value }))}
            placeholder="2028/29"
            className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          />
          <label className="mt-2 block text-xs font-medium text-slate-600" htmlFor="new-season-edition">
            Edition (optional)
          </label>
          <input
            id="new-season-edition"
            value={newSeason.edition}
            onChange={(e) => setNewSeason((s) => ({ ...s, edition: e.target.value }))}
            placeholder="X"
            className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          />
          <button
            type="submit"
            disabled={createSeason.isPending}
            className="mt-2 min-h-11 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
          >
            {createSeason.isPending ? 'Creating…' : 'Create season'}
          </button>
        </form>
      )}
    </>
  )
}
