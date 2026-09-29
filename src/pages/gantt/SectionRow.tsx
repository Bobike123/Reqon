import { useState } from 'react'
import type { MilestoneSection } from '../../data/useMilestones.ts'
import type { Task } from '../../data/useTasks.ts'
import { formatDay } from '../../lib/dates.ts'
import { Bar, ROW, STICKY_LABEL, Track } from './GanttChart.tsx'
import { taskDropHandlers } from './ganttDrag.ts'
import { GanttTaskRow } from './GanttTaskRow.tsx'
import { LinkTaskTool } from './LinkTaskTool.tsx'
import type { GanttEnv } from './ganttEnv.ts'
import { currentTargetKey, linkCandidates, relinkFrom } from './ganttLinking.ts'
import { sectionSpan, spanCaption, type Span } from './ganttModel.ts'
import { progressLabel, sectionProgress, tasksUnderSection, type ProgressSource } from './ganttProgress.ts'

// One milestone section: its drafted tick, its bar, and — when open — its Board
// tasks and the tool that links an existing one. Progress comes from ALL linked
// tasks (archived included) so archiving a Done task never lowers it; the rows
// listed are the active ones.
export function SectionRow({
  section,
  milestoneKey,
  tasks,
  progressTasks,
  fallbackSpan,
  open,
  onToggle,
  onDraftedChange,
  env,
}: {
  section: MilestoneSection
  milestoneKey: string
  tasks: Task[]
  progressTasks: ProgressSource[]
  fallbackSpan: Span | null
  open: boolean
  onToggle: () => void
  onDraftedChange: (isDrafted: boolean) => void
  env: GanttEnv
}) {
  const under = tasksUnderSection(tasks, section.id)
  const shown = under.filter(env.lens.matches)
  const progress = sectionProgress(section, progressTasks)
  const span = sectionSpan(tasks, section.id, fallbackSpan)
  const words = progressLabel(progress, 'section', 'done')
  const target = { seasonId: env.seasonId, milestoneKey, sectionId: section.id }
  const { direct, relink } = linkCandidates(tasks, target, (t) => env.permsFor(t).canEdit)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  // A task dragged from another row lands here (the same move as "Move to").
  const [dropOver, setDropOver] = useState(false)
  const drop = taskDropHandlers((taskId) => {
    const task = byId.get(taskId)
    if (task) env.onMoveTo(task, target)
  }, setDropOver)
  const dimmed = env.lens.active && shown.length === 0
  const link = (taskId: string) => {
    const task = byId.get(taskId)
    if (task) env.onLink(task, target)
  }

  return (
    <div data-testid={`gantt-section-${section.id}`} className={dimmed ? 'opacity-70' : undefined}>
      <div className={`${ROW} group py-1 ${dropOver ? "rounded ring-2 ring-slate-900" : ""}`} {...drop} data-drop-target="true">
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
          {/* The same tick as Milestones, writing to the same row (is_drafted).
              On the Gantt a ticked section reads as done. Plain members see it
              but cannot change it. */}
          <label className="ml-auto flex min-h-11 shrink-0 items-center gap-1 text-[11px] text-slate-600 sm:min-h-0">
            <input
              type="checkbox"
              checked={section.is_drafted}
              disabled={!env.canManage}
              aria-label={`${section.name} done`}
              onChange={(e) => onDraftedChange(e.target.checked)}
              className="h-4 w-4 accent-slate-900 disabled:opacity-60"
            />
            {progress.basis === 'tasks' ? `${progress.done}/${progress.total}` : 'done'}
          </label>
        </div>

        <Track
          today={env.todayLeft}
          summary={`${section.name}: ${words}${span ? `, ${formatDay(span.from)} to ${formatDay(span.to)}` : ''}${
            env.lens.active ? `. ${shown.length} task${shown.length === 1 ? '' : 's'} shown for ${env.lens.name}` : ''
          }`}
        >
          {span && (
            <Bar
              span={span}
              range={env.range}
              percent={progress.percent ?? 0}
              tone={under.length > 0 ? 'bg-slate-500' : 'bg-slate-300'}
              caption={spanCaption(span)}
              title={`${section.name}: ${formatDay(span.from)} → ${formatDay(span.to)} · ${words}${
                under.length === 0 ? ' (no dated subtasks — shows the submission window)' : ''
              }`}
            />
          )}
        </Track>
      </div>

      {open && (
        <>
          {shown.map((task) => {
            const perms = env.permsFor(task)
            return (
              <GanttTaskRow
                key={task.id}
                task={task}
                today={env.today}
                departmentName={task.subteam_key ? (env.departmentNames.get(task.subteam_key) ?? task.subteam_key) : null}
                ownerName={task.owner_id ? (env.memberNames.get(task.owner_id) ?? 'Unknown member') : null}
                members={env.members}
                range={env.range}
                todayLeft={env.todayLeft}
                perms={perms}
                unlink={
                  perms.canEdit
                    ? { kind: 'action', label: `Unlink ${task.title} from ${section.name}`, onUnlink: () => env.onUnlinkSection(task) }
                    : null
                }
                expanded={env.expandedTask === task.id}
                onToggle={() => env.onToggleTask(task.id)}
                moveTargets={env.moveTargets}
                currentTargetKey={currentTargetKey(task)}
                onMoveTo={(to) => env.onMoveTo(task, to)}
                onSchedule={(start, due) => env.onSchedule(task, start, due)}
                onMove={(state) => env.onMove(task.id, state)}
                onOwner={(ownerId) => env.onOwner(task.id, ownerId)}
              />
            )
          })}

          {under.length === 0 && (
            <p className="sticky left-0 z-10 w-fit bg-white pl-12 text-[11px] text-slate-600">
              No subtasks yet.{env.canManage ? ' Link an existing Board task below.' : ''}
            </p>
          )}
          {under.length > 0 && shown.length === 0 && (
            <p className="sticky left-0 z-10 w-fit bg-white pl-12 text-[11px] text-slate-600" data-testid={`gantt-section-empty-${section.id}`}>
              Nothing for {env.lens.name} in this section ({under.length} task{under.length === 1 ? '' : 's'} hidden by the
              filter).
            </p>
          )}

          {env.canManage && (
            <LinkTaskTool
              targetLabel={section.name}
              direct={direct.map((t) => ({ id: t.id, title: t.title }))}
              moves={relink.map((t) => ({ id: t.id, title: t.title, from: relinkFrom(t, (id) => env.sectionNames.get(id) ?? null) }))}
              onLink={link}
              onMove={link}
            />
          )}
        </>
      )}
    </div>
  )
}
