import { useId, useState } from 'react'
import { selectSmall } from './GanttChart.tsx'

type Direct = { id: string; title: string }
type Move = { id: string; title: string; from: string }

// The Gantt's ONE work-association control: adopt an existing Board task into
// this section (or into this submission's unsectioned work). It cannot create a
// task. A task that is already on another submission is offered separately, as a
// MOVE, and is only performed after an explicit confirmation that says where it
// comes from and that both its milestone and its section change together.
//
// Only tasks this person may link are passed in (see ganttLinking.linkCandidates);
// the database checks again on every write.
export function LinkTaskTool({
  targetLabel,
  direct,
  moves,
  onLink,
  onMove,
}: {
  // "Cover sheet", or "MS1-1 (no section yet)".
  targetLabel: string
  direct: Direct[]
  moves: Move[]
  onLink: (taskId: string) => void
  onMove: (taskId: string) => void
}) {
  const selectId = useId()
  const [pending, setPending] = useState<Move | null>(null)

  if (direct.length === 0 && moves.length === 0) {
    return (
      <p className="sticky left-12 z-10 my-1 ml-12 w-fit max-w-md bg-white text-[11px] text-slate-600" data-testid="link-none">
        No task to link here. You can link tasks you own, or that belong to a department you head.
      </p>
    )
  }

  return (
    <div className="sticky left-12 z-10 my-1 ml-12 flex w-fit max-w-md flex-col items-start gap-2 rounded border border-dashed border-slate-300 bg-slate-50 p-2">
      <label className="sr-only" htmlFor={selectId}>
        Link an existing board task to {targetLabel}
      </label>
      <select
        id={selectId}
        value=""
        onChange={(e) => {
          const id = e.target.value
          if (!id) return
          const move = moves.find((m) => m.id === id)
          if (move) setPending(move)
          else onLink(id)
        }}
        className={selectSmall}
      >
        <option value="">Link an existing task…</option>
        {direct.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
        {moves.length > 0 && (
          <optgroup label="Move from another submission">
            {moves.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title} (now on {t.from})
              </option>
            ))}
          </optgroup>
        )}
      </select>

      {pending && (
        <div role="group" aria-label="Confirm move" className="flex flex-col gap-1.5 text-xs text-slate-800" data-testid="link-confirm">
          <p>
            Move “{pending.title}” from {pending.from} to {targetLabel}? Its submission and its section both change
            together. It stays the same Board task.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                onMove(pending.id)
                setPending(null)
              }}
              className="min-h-11 rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            >
              Move task
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
