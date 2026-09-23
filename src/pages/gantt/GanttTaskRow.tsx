import type { Member } from '../../data/useMembers.ts'
import type { Task, TaskState } from '../../data/useTasks.ts'
import { formatDay } from '../../lib/dates.ts'
import { TASK_STATES, TASK_STATE_GANTT_TONE } from '../../tasks/taskState.ts'
import { Bar, ROW, STICKY_LABEL, selectSmall, Track } from './GanttChart.tsx'
import type { Span } from './ganttModel.ts'

// One subtask under an expanded section: its lane, its owner, unlinking it,
// and its one-day bar on the timeline (Phase 6 §6.3).
export function GanttTaskRow({
  task,
  sectionName,
  members,
  range,
  todayLeft,
  onMove,
  onOwner,
  onUnlink,
}: {
  task: Task
  sectionName: string
  members: Member[]
  range: Span
  todayLeft: number | null
  onMove: (state: TaskState) => void
  onOwner: (ownerId: string | null) => void
  onUnlink: () => void
}) {
  return (
    <div className={`${ROW} group py-1`} data-testid={`gantt-task-${task.id}`} data-task-state={task.state}>
      <div className={`${STICKY_LABEL} flex flex-wrap items-center gap-1 bg-white pl-12 pr-2 group-hover:bg-slate-100`}>
        <span className="w-full text-xs text-slate-700">{task.title}</span>
        <label className="sr-only" htmlFor={`gantt-state-${task.id}`}>
          Move {task.title} to another lane
        </label>
        <select
          id={`gantt-state-${task.id}`}
          value={task.state}
          onChange={(e) => onMove(e.target.value as TaskState)}
          className={selectSmall}
        >
          {TASK_STATES.map((s) => (
            <option key={s.state} value={s.state}>
              {s.label}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor={`gantt-owner-${task.id}`}>
          Owner for {task.title}
        </label>
        <select
          id={`gantt-owner-${task.id}`}
          value={task.owner_id ?? ''}
          onChange={(e) => onOwner(e.target.value || null)}
          className={selectSmall}
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name}
            </option>
          ))}
        </select>
        {/* Unlinking leaves the task on the Board. Deleting one is still the
            Board's job. */}
        <button
          type="button"
          onClick={onUnlink}
          aria-label={`Unlink ${task.title} from ${sectionName}`}
          className="min-h-11 rounded px-1 text-[11px] text-slate-500 underline underline-offset-2 hover:text-slate-800 sm:min-h-0"
        >
          Unlink
        </button>
      </div>

      <Track today={todayLeft} label={task.due_date ? undefined : 'No due date'}>
        {task.due_date && (
          <Bar
            span={{ from: task.due_date, to: task.due_date }}
            range={range}
            tone={TASK_STATE_GANTT_TONE[task.state]}
            title={`${task.title}: due ${formatDay(task.due_date)}`}
          />
        )}
      </Track>
    </div>
  )
}
