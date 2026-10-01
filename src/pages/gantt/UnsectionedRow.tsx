import { milestoneLabel } from '../../milestones/label.ts'
import { useState } from 'react'
import type { Milestone } from '../../data/useMilestones.ts'
import type { Task } from '../../data/useTasks.ts'
import { formatDay } from '../../lib/dates.ts'
import { Bar, ROW, STICKY_LABEL, Track } from './GanttChart.tsx'
import { taskDropHandlers } from './ganttDrag.ts'
import { GanttTaskRow } from './GanttTaskRow.tsx'
import { LinkTaskTool } from './LinkTaskTool.tsx'
import type { GanttEnv } from './ganttEnv.ts'
import { canUnlinkMilestone, currentTargetKey, linkCandidates, relinkFrom } from './ganttLinking.ts'
import { spanCaption, spanOfDates } from './ganttModel.ts'
import { lensProgress, progressLabel, unsectionedFor, type ProgressSource } from './ganttProgress.ts'

// Work linked to a submission before any section is chosen. It is a group in the
// UI only: there is no section record behind it, and a task in it still belongs
// to exactly one milestone. Linking here sets only the milestone; picking a
// section later (under one of the sections above) moves it in.
export function UnsectionedRow({
  milestone,
  tasks,
  progressTasks,
  open,
  onToggle,
  env,
}: {
  milestone: Milestone
  tasks: Task[]
  progressTasks: ProgressSource[]
  open: boolean
  onToggle: () => void
  env: GanttEnv
}) {
  const under = unsectionedFor(tasks, milestone.key)
  const shown = under.filter(env.lens.matches)
  const words = progressLabel(lensProgress([], unsectionedFor(progressTasks, milestone.key), milestone.key))
  const span = spanOfDates(under.flatMap((t) => [t.starts_on, t.due_date]))
  const target = { seasonId: env.seasonId, milestoneKey: milestone.key, sectionId: null }
  const { direct, relink } = linkCandidates(tasks, target, (t) => env.permsFor(t).canEdit)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  // A task dragged from another row lands here (the same move as "Move to").
  const [dropOver, setDropOver] = useState(false)
  const drop = taskDropHandlers((taskId) => {
    const task = byId.get(taskId)
    if (task) env.onMoveTo(task, target)
  }, setDropOver)
  const link = (taskId: string) => {
    const task = byId.get(taskId)
    if (task) env.onLink(task, target)
  }

  return (
    <div data-testid={`gantt-unsectioned-${milestone.key}`} className={env.lens.active && shown.length === 0 ? 'opacity-70' : undefined}>
      <div className={`${ROW} group py-1 ${dropOver ? "rounded ring-2 ring-slate-900" : ""}`} {...drop} data-drop-target="true">
        <div className={`${STICKY_LABEL} flex items-center gap-1.5 bg-white pl-6 pr-2 group-hover:bg-slate-100`}>
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex min-h-11 items-center gap-1.5 text-left text-xs italic text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          >
            <span aria-hidden="true" className="w-3 text-slate-500">
              {open ? '▾' : '▸'}
            </span>
            Unsectioned work ({under.length})
          </button>
          <span className="ml-auto shrink-0 text-[11px] text-slate-600">no section yet</span>
        </div>
        <Track
          today={env.todayLeft}
          summary={`Unsectioned work under ${milestoneLabel(milestone)}: ${under.length} task${under.length === 1 ? '' : 's'}, ${words}`}
        >
          {span && (
            <Bar
              span={span}
              range={env.range}
              variant="outline"
              tone="border-slate-400 text-slate-600"
              caption={spanCaption(span)}
              title={`Unsectioned work: ${formatDay(span.from)} → ${formatDay(span.to)} · ${words}`}
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
                  !perms.canEdit
                    ? null
                    : canUnlinkMilestone(task)
                      ? { kind: 'action', label: `Unlink ${task.title} from ${milestoneLabel(milestone)}`, onUnlink: () => env.onUnlinkMilestone(task) }
                      : { kind: 'kept', reason: 'Keeps its submission (made from a proposal)' }
                }
                expanded={env.expandedTask === task.id}
                onToggle={() => env.onToggleTask(task.id)}
                moveTargets={env.moveTargets}
                currentTargetKey={currentTargetKey(task)}
                onMoveTo={(to) => env.onMoveTo(task, to)}
                onSchedule={(start, due) => env.onSchedule(task, start, due)}
                prerequisites={env.prerequisitesFor(task)}
                onMove={(state, reason) => env.onMove(task.id, state, reason)}
                onOwner={(ownerId) => env.onOwner(task.id, ownerId)}
              />
            )
          })}

          {under.length === 0 && (
            <p className="sticky left-0 z-10 w-fit bg-white pl-12 text-[11px] text-slate-600">
              Nothing is linked to {milestoneLabel(milestone)} without a section.
              {env.canManage ? ' Link a Board task below, or link it to a section above.' : ''}
            </p>
          )}
          {under.length > 0 && shown.length === 0 && (
            <p className="sticky left-0 z-10 w-fit bg-white pl-12 text-[11px] text-slate-600" data-testid={`gantt-unsectioned-empty-${milestone.key}`}>
              Nothing for {env.lens.name} without a section ({under.length} task{under.length === 1 ? '' : 's'} hidden by
              the filter).
            </p>
          )}

          {env.canManage && (
            <LinkTaskTool
              targetLabel={`${milestoneLabel(milestone)} (no section yet)`}
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
