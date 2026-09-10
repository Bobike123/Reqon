import { PageHeader } from '../ui/PageHeader.tsx'
import { ErrorState } from '../ui/states.tsx'
import { useMembers } from '../data/useMembers.ts'
import { useTasks, useUpdateTask, type Task, type TaskState } from '../data/useTasks.ts'
import { useTopics } from '../data/useTopics.ts'

// Six lanes, exactly the six task_state values in the schema. Do not add a
// seventh here without adding it to the enum first.
const LANES: { state: TaskState; label: string; tone: string }[] = [
  { state: 'urgent', label: 'Urgent', tone: 'border-red-300 bg-red-50' },
  { state: 'todo', label: 'To do', tone: 'border-slate-200 bg-white' },
  { state: 'wip', label: 'In progress', tone: 'border-blue-200 bg-blue-50' },
  { state: 'blocked', label: 'Blocked', tone: 'border-amber-300 bg-amber-50' },
  { state: 'done', label: 'Done', tone: 'border-green-200 bg-green-50' },
  { state: 'cancelled', label: 'Cancelled', tone: 'border-slate-200 bg-slate-100' },
]

// Movement is a <select>, not drag-and-drop. A drag library is a large
// dependency, and a drag target is unusable with a keyboard and awkward on a
// phone — which is exactly where this board gets used, in the workshop and at
// the track. The select works everywhere and needs no maintenance.
function TaskCard({
  task,
  members,
  sourceTopicTitle,
  onMove,
  onSetOwner,
  moving,
}: {
  task: Task
  members: { id: string; full_name: string }[]
  sourceTopicTitle?: string
  onMove: (id: string, state: TaskState) => void
  onSetOwner: (id: string, ownerId: string | null) => void
  moving: boolean
}) {
  const overdue =
    task.due_date !== null &&
    task.due_date < new Date().toISOString().slice(0, 10) &&
    task.state !== 'done' &&
    task.state !== 'cancelled'

  return (
    <li
      className="rounded border border-slate-200 bg-white p-2"
      data-testid={`task-${task.id}`}
      data-task-state={task.state}
      data-source-topic={task.source_topic ?? ''}
    >
      <p className="text-sm font-medium text-slate-900">{task.title}</p>
      {task.detail && <p className="mt-0.5 text-xs text-slate-600">{task.detail}</p>}

      {sourceTopicTitle && (
        <p className="mt-1 text-[11px] text-slate-500" data-testid={`task-origin-${task.id}`}>
          From topic: “{sourceTopicTitle}”
        </p>
      )}

      {task.due_date && (
        <p className={`mt-1 text-[11px] ${overdue ? 'font-semibold text-red-700' : 'text-slate-500'}`}>
          Due {task.due_date}
          {overdue ? ' · overdue' : ''}
        </p>
      )}

      <div className="mt-2 space-y-1">
        <label className="sr-only" htmlFor={`task-state-${task.id}`}>
          Move {task.title} to another lane
        </label>
        <select
          id={`task-state-${task.id}`}
          value={task.state}
          disabled={moving}
          onChange={(e) => onMove(task.id, e.target.value as TaskState)}
          className="min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
        >
          {LANES.map((l) => (
            <option key={l.state} value={l.state}>
              {l.label}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor={`task-owner-${task.id}`}>
          Owner for {task.title}
        </label>
        <select
          id={`task-owner-${task.id}`}
          value={task.owner_id ?? ''}
          onChange={(e) => onSetOwner(task.id, e.target.value || null)}
          className="min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name}
            </option>
          ))}
        </select>
      </div>
    </li>
  )
}

export default function Board() {
  const tasks = useTasks()
  const members = useMembers()
  const topics = useTopics()
  const updateTask = useUpdateTask()

  const topicTitles = new Map((topics.data ?? []).map((t) => [t.id, t.title]))

  const error = tasks.error ?? members.error
  if (error) {
    return (
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-3 py-4 sm:px-6 *:max-w-6xl">
        <h1 className="text-xl font-semibold text-slate-900">Board</h1>
        <div className="mt-4">
          <ErrorState
            title="Could not load the board"
            error={error}
            onRetry={() => {
              void tasks.refetch()
              void members.refetch()
            }}
          />
        </div>
      </main>
    )
  }

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-3 py-4 sm:px-6 *:max-w-6xl">
      <PageHeader
        title="Board"
        description="The team’s tasks. Move a task between lanes with the dropdown on its card."
      />

      {updateTask.isError && (
        <p role="alert" className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          Could not move that task: {updateTask.error.message}
        </p>
      )}
      {updateTask.isPending && (
        <p role="status" className="mb-3 text-xs text-slate-500">Saving…</p>
      )}

      {tasks.isLoading && (
        <p role="status" className="mb-3 text-xs text-slate-500">Loading…</p>
      )}

      {/* Lanes render immediately and fill in; they are not swapped out for a
          spinner, so an open select is never yanked away mid-change. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" data-tutorial="board-lanes">
          {LANES.map((lane) => {
            const laneTasks = (tasks.data ?? []).filter((t) => t.state === lane.state)
            return (
              <section
                key={lane.state}
                className={`rounded-lg border p-2 ${lane.tone}`}
                aria-labelledby={`lane-${lane.state}`}
                data-testid={`lane-${lane.state}`}
              >
                <h2 id={`lane-${lane.state}`} className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
                  {lane.label}{' '}
                  <span className="font-normal text-slate-700">({laneTasks.length})</span>
                </h2>
                {laneTasks.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-slate-700">Nothing here.</p>
                ) : (
                  <ul className="space-y-2">
                    {laneTasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        members={members.data ?? []}
                        sourceTopicTitle={
                          task.source_topic ? topicTitles.get(task.source_topic) : undefined
                        }
                        moving={updateTask.isPending}
                        onMove={(id, state) => updateTask.mutate({ id, state })}
                        onSetOwner={(id, ownerId) => updateTask.mutate({ id, ownerId })}
                      />
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
      </div>
    </main>
  )
}
