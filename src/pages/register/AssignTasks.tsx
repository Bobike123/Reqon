import { useId, useMemo, useState } from 'react'
import { useLinkTaskRequirement, useUnlinkTaskRequirement } from '../../data/useTasks.ts'
import { TASK_STATE_LABEL } from '../../tasks/taskState.ts'
import type { Task } from '../../tasks/types.ts'
import { ActionError } from '../../ui/states.tsx'

export type AssignCandidate = Pick<Task, 'id' | 'title' | 'state' | 'owner_id' | 'subteam_key' | 'archived_at'>

// Link EXISTING Board tasks to one requirement, or unlink them — the same
// link_task_requirement / unlink_task_requirement commands the task editor uses,
// under the same rule (the task's owner, its department's Head, or a Developer;
// the database checks again). It never creates or copies a task, never changes
// its owner, department or state, and never touches the requirement's own
// compliance status: completing linked work is not compliance.
export function AssignTasks({
  clauseKey,
  printedRef,
  linked,
  candidates,
  canEdit,
  memberNames,
  departmentNames,
  onClose,
}: {
  clauseKey: string
  printedRef: string
  // Every task currently linked (active and archived), by id.
  linked: ReadonlyMap<string, AssignCandidate>
  // Active Board tasks that could be linked.
  candidates: readonly AssignCandidate[]
  canEdit: (task: AssignCandidate) => boolean
  memberNames: ReadonlyMap<string, string>
  departmentNames: ReadonlyMap<string, string>
  onClose: () => void
}) {
  const id = useId()
  const link = useLinkTaskRequirement()
  const unlink = useUnlinkTaskRequirement()
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [done, setDone] = useState<string | null>(null)

  // Linked ones first (archived included, so finished work is shown for what it
  // is), then the rest, filtered by title, owner or department.
  const rows = useMemo(() => {
    const byId = new Map<string, AssignCandidate>(candidates.map((t) => [t.id, t]))
    for (const [taskId, task] of linked) byId.set(taskId, task)
    const q = search.trim().toLowerCase()
    const match = (t: AssignCandidate) =>
      q === '' ||
      t.title.toLowerCase().includes(q) ||
      (t.owner_id ? (memberNames.get(t.owner_id) ?? '') : '').toLowerCase().includes(q) ||
      (t.subteam_key ? (departmentNames.get(t.subteam_key) ?? t.subteam_key) : '').toLowerCase().includes(q)
    return [...byId.values()]
      .filter(match)
      .sort((a, b) => Number(linked.has(b.id)) - Number(linked.has(a.id)) || a.title.localeCompare(b.title))
  }, [candidates, linked, search, memberNames, departmentNames])

  async function toggle(task: AssignCandidate) {
    setPending(task.id)
    setError(null)
    setDone(null)
    try {
      // Both commands say whether they changed anything: someone else may have
      // linked or unlinked the same pair since this list was loaded, and one
      // pair is only ever linked once (the table's key).
      if (linked.has(task.id)) {
        const changed = await unlink.mutateAsync({ taskId: task.id, clauseKey })
        setDone(changed ? `“${task.title}” is no longer linked to ${printedRef}.` : `“${task.title}” was already not linked to ${printedRef}.`)
      } else {
        const changed = await link.mutateAsync({ taskId: task.id, clauseKey })
        setDone(
          changed
            ? `“${task.title}” is now linked to ${printedRef}. Its owner, department and status are unchanged.`
            : `“${task.title}” was already linked to ${printedRef} — nothing was added twice.`,
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e : new Error('That did not work.'))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="mt-2 rounded border border-slate-300 bg-white p-2" data-testid={`assign-tasks-${clauseKey}`}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={`${id}-q`} className="block text-xs font-medium text-slate-700">
            Find a task to link to {printedRef}
          </label>
          <input
            id={`${id}-q`}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Title, owner or department"
            className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          />
        </div>
        <button type="button" onClick={onClose} className="min-h-11 rounded px-2 text-xs underline underline-offset-2 sm:min-h-0">
          Done
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-600">
        Linking keeps the task as it is — same id, owner, department and progress — and does not make the rule compliant.
        You can link tasks you own, or that belong to a department you head.
      </p>
      <ActionError error={error} className="mt-2" />
      {done && (
        <p role="status" className="mt-2 text-xs text-emerald-800">
          {done}
        </p>
      )}
      <ul className="mt-2 max-h-72 divide-y divide-slate-100 overflow-auto" aria-label={`Tasks for ${printedRef}`}>
        {rows.length === 0 && <li className="py-2 text-sm text-slate-600">No task matches.</li>}
        {rows.slice(0, 60).map((task) => {
          const isLinked = linked.has(task.id)
          const archived = task.archived_at !== null
          const allowed = !archived && canEdit(task)
          return (
            <li key={task.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-sm" data-testid={`assign-row-${task.id}`}>
              <span className="min-w-0 flex-1">
                <span className="font-medium text-slate-900">{task.title}</span>
                <span className="block text-xs text-slate-600">
                  {TASK_STATE_LABEL[task.state]}
                  {archived ? (task.state === 'done' ? ' · archived, done' : ' · archived, not finished') : ''} ·{' '}
                  {task.owner_id ? (memberNames.get(task.owner_id) ?? 'someone') : 'unassigned'} ·{' '}
                  {task.subteam_key ? (departmentNames.get(task.subteam_key) ?? task.subteam_key) : 'no department'}
                  {isLinked ? ' · linked' : ''}
                </span>
              </span>
              {allowed ? (
                <button
                  type="button"
                  disabled={pending !== null}
                  onClick={() => void toggle(task)}
                  className={`min-h-11 rounded border px-2 py-0.5 text-xs font-medium sm:min-h-0 ${
                    isLinked ? 'border-slate-300 bg-white text-slate-800 hover:bg-slate-100' : 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800'
                  }`}
                >
                  {pending === task.id ? 'Saving…' : isLinked ? 'Unlink' : 'Link'}
                  <span className="sr-only"> {task.title}</span>
                </button>
              ) : (
                <span className="text-xs text-slate-500">{archived ? 'Archived — restore it to change links' : 'Not yours to link'}</span>
              )}
            </li>
          )
        })}
      </ul>
      {rows.length > 60 && <p className="mt-1 text-xs text-slate-600">Showing 60 of {rows.length}; type to narrow it down.</p>}
    </div>
  )
}
