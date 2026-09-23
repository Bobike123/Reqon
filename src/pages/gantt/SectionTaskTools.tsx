import { useState } from 'react'
import type { Task } from '../../data/useTasks.ts'
import { buttonSecondary } from '../../ui/buttons.ts'
import { selectSmall } from './GanttChart.tsx'
import type { MilestoneSection } from '../../data/useMilestones.ts'

// The row under an expanded section: create a board task here, or adopt one
// that already exists. Both end up as the same thing — a task with section_id
// set — which is why there is no third option. Named SectionTaskTools
// (Phase 6 §6.3); was SubtaskTools, unchanged in content.
export function SectionTaskTools({
  section,
  unlinked,
  canCreate,
  onCreate,
  onLink,
  busy,
}: {
  section: MilestoneSection
  unlinked: Task[]
  canCreate: boolean
  onCreate: (title: string) => void
  onLink: (taskId: string) => void
  busy: boolean
}) {
  const [title, setTitle] = useState('')

  return (
    <div className="sticky left-12 z-10 my-1 ml-12 flex w-fit max-w-md flex-col items-start gap-2 rounded border border-dashed border-slate-300 bg-slate-50 p-2">
      {canCreate && (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            const trimmed = title.trim()
            if (!trimmed) return
            onCreate(trimmed)
            setTitle('')
          }}
        >
          <label className="sr-only" htmlFor={`add-${section.id}`}>
            New subtask for {section.name}
          </label>
          <input
            id={`add-${section.id}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New subtask…"
            maxLength={200}
            className="min-h-11 w-48 rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          />
          <button type="submit" className={`${buttonSecondary} text-xs`} disabled={busy || !title.trim()}>
            Add to Board
          </button>
        </form>
      )}

      {unlinked.length > 0 && (
        <>
          <label className="sr-only" htmlFor={`link-${section.id}`}>
            Link an existing board task to {section.name}
          </label>
          <select
            id={`link-${section.id}`}
            value=""
            onChange={(e) => e.target.value && onLink(e.target.value)}
            className={selectSmall}
          >
            <option value="">Link an existing task…</option>
            {unlinked.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  )
}
