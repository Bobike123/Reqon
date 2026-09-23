import type { Member } from '../../data/useMembers.ts'
import type { Milestone, MilestoneSection } from '../../data/useMilestones.ts'
import type { Task, TaskState } from '../../data/useTasks.ts'
import { formatDay } from '../../lib/dates.ts'
import { sectionsFor, submissionWindow } from '../milestones/milestoneModel.ts'
import { Bar, ROW, STICKY_LABEL, Track } from './GanttChart.tsx'
import { SectionRow } from './SectionRow.tsx'
import { milestonePercent, milestoneSpan, type Span } from './ganttModel.ts'

// One submission window: its bar, its percent-done badge, and — when open —
// its sections (Phase 6 §6.3).
export function MilestoneRow({
  milestone,
  sections,
  tasks,
  unlinked,
  range,
  todayLeft,
  open,
  onToggle,
  openSections,
  onToggleSection,
  members,
  onDraftedChange,
  canCreateTask,
  addingTask,
  onCreateTask,
  onLinkTask,
  onMoveTask,
  onOwnerTask,
  onUnlinkTask,
  now,
}: {
  milestone: Milestone
  sections: MilestoneSection[]
  tasks: Task[]
  unlinked: Task[]
  range: Span
  todayLeft: number | null
  open: boolean
  onToggle: () => void
  openSections: ReadonlySet<string>
  onToggleSection: (sectionId: string) => void
  members: Member[]
  onDraftedChange: (sectionId: string, isDrafted: boolean) => void
  canCreateTask: boolean
  addingTask: boolean
  onCreateTask: (sectionId: string, title: string) => void
  onLinkTask: (sectionId: string, taskId: string) => void
  onMoveTask: (taskId: string, state: TaskState) => void
  onOwnerTask: (taskId: string, ownerId: string | null) => void
  onUnlinkTask: (taskId: string) => void
  // Passed in rather than read with `new Date()` here, so this component
  // stays deterministic under a test that pins the moment (Phase 5 §5.1).
  now: Date
}) {
  const mySections = sectionsFor(sections, milestone.key)
  const span = milestoneSpan(milestone)
  const window = submissionWindow(milestone, now)
  const percent = milestonePercent(mySections, tasks)

  return (
    <li className="border-b border-slate-100 py-1.5 last:border-0" data-testid={`gantt-milestone-${milestone.key}`}>
      <div className={`${ROW} rounded bg-slate-100 py-0.5`}>
        <div className={`${STICKY_LABEL} flex items-center gap-1.5 bg-slate-100 pr-2`}>
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex min-h-11 items-center gap-1.5 text-left text-sm font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          >
            <span aria-hidden="true" className="w-3 text-slate-500">
              {open ? '▾' : '▸'}
            </span>
            <span className="font-mono text-xs">{milestone.key}</span>
            <span className="font-normal">{milestone.name}</span>
          </button>
          <span
            className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${
              percent === 100
                ? 'bg-green-100 text-green-800'
                : window.kind === 'dated' && window.passed
                  ? 'bg-red-100 text-red-800'
                  : 'bg-slate-200 text-slate-700'
            }`}
          >
            {percent}%
          </span>
        </div>

        <Track today={todayLeft}>
          {span && (
            <Bar
              span={span}
              range={range}
              percent={percent}
              tone={window.kind === 'dated' && window.passed && percent < 100 ? 'bg-red-600' : 'bg-slate-700'}
              title={`${milestone.key}: ${span.from === span.to ? '' : `${formatDay(span.from)} → `}${formatDay(
                span.to,
              )} · ${percent}% done`}
            />
          )}
        </Track>
      </div>

      {open && mySections.length === 0 && (
        <p className="sticky left-0 z-10 w-fit bg-white py-1 pl-6 text-xs text-slate-500">
          No sections listed for this submission yet.
        </p>
      )}

      {open &&
        mySections.map((section) => (
          <SectionRow
            key={section.id}
            section={section}
            tasks={tasks}
            unlinked={unlinked}
            fallbackSpan={span}
            range={range}
            todayLeft={todayLeft}
            open={openSections.has(section.id)}
            onToggle={() => onToggleSection(section.id)}
            members={members}
            onDraftedChange={(isDrafted) => onDraftedChange(section.id, isDrafted)}
            canCreateTask={canCreateTask}
            addingTask={addingTask}
            onCreateTask={(title) => onCreateTask(section.id, title)}
            onLinkTask={(taskId) => onLinkTask(section.id, taskId)}
            onMoveTask={onMoveTask}
            onOwnerTask={onOwnerTask}
            onUnlinkTask={onUnlinkTask}
          />
        ))}
    </li>
  )
}
