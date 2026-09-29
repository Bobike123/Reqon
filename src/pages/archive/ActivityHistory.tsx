import { useState } from 'react'
import { Link } from 'react-router-dom'
import { actorLabel, presentActivity } from '../../activity/presentation.ts'
import { useActivityHistory } from '../../data/useActivityHistory.ts'
import { formatInstant } from '../../lib/dates.ts'
import { buttonSecondary } from '../../ui/buttons.ts'

export function ActivityHistory({
  entity,
  entityId,
  memberNames,
}: {
  entity: 'task' | 'proposal'
  entityId: string
  memberNames: ReadonlyMap<string, string>
}) {
  const [open, setOpen] = useState(false)
  const history = useActivityHistory(entity, entityId, open)
  const rows = history.data?.rows ?? []

  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      <button
        type="button"
        className="inline-flex min-h-11 items-center text-xs font-medium text-slate-700 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide change history' : 'Show change history'}
      </button>

      {open && (
        <div className="mt-2" data-testid={`activity-history-${entityId}`}>
          {history.isLoading && <p role="status" className="text-xs text-slate-500">Loading change history…</p>}
          {history.error && (
            <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-900">
              <span aria-hidden="true">! </span>Could not load change history: {history.error.message}
            </p>
          )}
          {!history.isLoading && !history.error && rows.length === 0 && (
            <p className="text-xs text-slate-500">No recorded changes for this item.</p>
          )}
          {rows.length > 0 && (
            <ol className="space-y-2" aria-label="Change history, newest first">
              {rows.map((row) => {
                const event = presentActivity(row, memberNames)
                return (
                  <li key={row.id} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2 text-xs text-slate-700">
                    <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-400 font-semibold">
                      {event.icon}
                    </span>
                    <div>
                      <p className="font-medium text-slate-900">{event.summary}</p>
                      <p>{actorLabel(row, memberNames)} · {formatInstant(row.at)}</p>
                      {event.reason && event.reason !== 'auto_done_24h' && <p>Reason: {event.reason}</p>}
                      {event.proposalId && (
                        <Link className="font-medium underline underline-offset-2" to={`/archive?tab=proposals&id=${event.proposalId}`}>
                          Open source proposal
                        </Link>
                      )}
                      {event.taskId && (
                        <Link className="font-medium underline underline-offset-2" to={`/archive?tab=tasks&id=${event.taskId}`}>
                          Open resulting task
                        </Link>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
          {history.hasNextPage && (
            <button type="button" className={`${buttonSecondary} mt-2`} disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
              {history.isFetchingNextPage ? 'Loading…' : 'Load older changes'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
