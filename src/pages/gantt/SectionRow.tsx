import type { Member } from '../../data/useMembers.ts'
import type { MilestoneSection } from '../../data/useMilestones.ts'
import type { Task, TaskState } from '../../data/useTasks.ts'
import { formatDay } from '../../lib/dates.ts'
import { Bar, ROW, STICKY_LABEL, Track } from './GanttChart.tsx'
import { GanttTaskRow } from './GanttTaskRow.tsx'
import { SectionTaskTools } from './SectionTaskTools.tsx'
import { progressOf, sectionPercent, sectionSpan, tasksInSection, type Span } from './ganttModel.ts'

// One milestone section: its drafted tick, its bar, and — when open — its
// subtask rows and the add/link tools (Phase 6 §6.3).
export function SectionRow({
  section,
  tasks,
  unlinked,
  fallbackSpan,
  range,
  todayLeft,
  open,
  onToggle,
  members,
  onDraftedChange,
  canCreateTask,
  addingTask,
  onCreateTask,
  onLinkTask,
  onMoveTask,
  onOwnerTask,
  onUnlinkTask,
}: {
  section: MilestoneSection
  tasks: Task[]
  unlinked: Task[]
  fallbackSpan: Span | null
  range: Span
  todayLeft: number | null
  open: boolean
  onToggle: () => void
  members: Member[]
  onDraftedChange: (isDrafted: boolean) => void
  canCreateTask: boolean
  addingTask: boolean
  onCreateTask: (title: string) => void
  onLinkTask: (taskId: string) => void
  onMoveTask: (taskId: string, state: TaskState) => void
  onOwnerTask: (taskId: string, ownerId: string | null) => void
  onUnlinkTask: (taskId: string) => void
}) {
  const mine = tasksInSection(tasks, section.id)
  const progress = progressOf(mine)
  const span = sectionSpan(tasks, section.id, fallbackSpan)

  return (
    <div data-testid={`gantt-section-${section.id}`}>
      <div className={`${ROW} group py-1`}>
        <div className={`${STICKY_LABEL} flex items-center gap-1.5 bg-white pl-6 pr-2 group-hover:bg-slate-100`}>
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex min-h-11 items-center gap-1.5 text-left text-xs text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          >
            <span aria-hidden="true" className="w-3 text-slate-500">
              {open ? '▾' : '▸'}
            </span>
            {section.name}
          </button>
          {/* The same tick as Milestones, writing to the same row: one
              checklist, two screens. */}
          <label className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-slate-500">
            <input
              type="checkbox"
              checked={section.is_drafted}
              aria-label={`${section.name} drafted`}
              onChange={(e) => onDraftedChange(e.target.checked)}
              className="h-4 w-4 accent-slate-900"
            />
            {progress.total > 0 ? `${progress.done}/${progress.total}` : 'drafted'}
          </label>
        </div>

        <Track today={todayLeft}>
          {span && (
            <Bar
              span={span}
              range={range}
              percent={sectionPercent(section, tasks)}
              tone={mine.length > 0 ? 'bg-slate-500' : 'bg-slate-300'}
              title={`${section.name}: ${formatDay(span.from)} → ${formatDay(span.to)}${
                mine.length === 0 ? ' (no dated subtasks — shows the submission window)' : ''
              }`}
            />
          )}
        </Track>
      </div>

      {open && (
        <>
          {mine.map((task) => (
            <GanttTaskRow
              key={task.id}
              task={task}
              sectionName={section.name}
              members={members}
              range={range}
              todayLeft={todayLeft}
              onMove={(state) => onMoveTask(task.id, state)}
              onOwner={(ownerId) => onOwnerTask(task.id, ownerId)}
              onUnlink={() => onUnlinkTask(task.id)}
            />
          ))}

          {mine.length === 0 && (
            <p className="sticky left-0 z-10 w-fit bg-white pl-12 text-[11px] text-slate-500">
              No subtasks yet. Anything added here is a real Board task.
            </p>
          )}

          <SectionTaskTools
            section={section}
            unlinked={unlinked}
            canCreate={canCreateTask}
            busy={addingTask}
            onCreate={onCreateTask}
            onLink={onLinkTask}
          />
        </>
      )}
    </div>
  )
}
