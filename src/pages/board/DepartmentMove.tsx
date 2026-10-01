import { useId, useState } from 'react'
import { useSetTaskDepartment } from '../../data/useTasks.ts'
import { buttonSecondary } from '../../ui/buttons.ts'
import { ActionError } from '../../ui/states.tsx'

const FIELD =
  'mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'
const LABEL = 'block text-xs font-medium text-slate-700'
const MAX_REASON = 500

// Which department a task belongs to is never part of the ordinary edit: it is its
// own command (set_task_department), with a reason the audit trail keeps. Shown only
// to someone the database would let move THIS task (taskDepartmentTargets): the
// President, Vice President or a Developer, or a Head between departments they head.
export function DepartmentMove(props: {
  taskId: string
  currentName: string | null
  targets: { key: string; name: string }[]
}) {
  const move = useSetTaskDepartment()
  const uid = useId()
  const [target, setTarget] = useState('')
  const [reason, setReason] = useState('')
  const [moved, setMoved] = useState<string | null>(null)
  const chosen = props.targets.some((d) => d.key === target) ? target : ''
  const trimmed = reason.trim()

  return (
    <section className="border-t border-slate-100 pt-2" aria-labelledby={`${uid}-h`} data-testid={`task-department-${props.taskId}`}>
      <h4 id={`${uid}-h`} className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
        Department
      </h4>
      <p className="mt-0.5 text-sm text-slate-700">{props.currentName ?? 'No department yet.'}</p>
      <form
        noValidate
        className="mt-1 grid gap-2 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (chosen === '' || trimmed === '' || move.isPending) return
          const name = props.targets.find((d) => d.key === chosen)?.name ?? chosen
          setMoved(null)
          move.mutate(
            { id: props.taskId, departmentKey: chosen, reason: trimmed },
            {
              onSuccess: () => {
                setMoved(name)
                setTarget('')
                setReason('')
              },
            },
          )
        }}
      >
        <div>
          <label htmlFor={`${uid}-to`} className={LABEL}>
            {props.currentName ? 'Move to' : 'Give it a department'}
          </label>
          <select id={`${uid}-to`} value={chosen} onChange={(e) => setTarget(e.target.value)} className={FIELD} disabled={move.isPending}>
            <option value="">Choose a department…</option>
            {props.targets.map((d) => (
              <option key={d.key} value={d.key}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-why`} className={LABEL}>
            Why? (kept in the history)
          </label>
          <input
            id={`${uid}-why`}
            value={reason}
            maxLength={MAX_REASON}
            onChange={(e) => setReason(e.target.value)}
            className={FIELD}
            disabled={move.isPending}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <button
            type="submit"
            className={buttonSecondary}
            disabled={chosen === '' || trimmed === '' || move.isPending}
            data-testid={`task-department-move-${props.taskId}`}
          >
            {move.isPending ? 'Moving…' : 'Move task'}
          </button>
          {moved && !move.isPending && (
            <span role="status" className="text-sm text-green-700">
              Moved to {moved}.
            </span>
          )}
        </div>
      </form>
      <ActionError error={move.error} className="mt-1" />
    </section>
  )
}
