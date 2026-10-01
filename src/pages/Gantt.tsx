import { useId, useMemo, useState } from 'react'
import { useAuth } from '../auth/context.ts'
import { canEditTask, canReassignTaskOwner } from '../auth/permissions.ts'
import { DepartmentNav } from '../departments/DepartmentNav.tsx'
import { ScopeDepartmentFilter } from '../departments/ScopeDepartmentFilter.tsx'
import { departmentChoices } from '../departments/filter.ts'
import { formatDay, todayIso } from '../lib/dates.ts'
import { milestoneLabel } from '../milestones/label.ts'
import { useSeasonId } from '../season/context.ts'
import { mergeSearchParams, readSetParam, writeSetParam } from '../lib/searchParams.ts'
import { applyTaskFilter, filterTasks, isDefaultTaskFilter, taskFilterFromParams, taskScopeCounts, type TaskFilter } from '../tasks/filters.ts'
import { prerequisitesOf, taskRefLookup } from '../tasks/dependencies.ts'
import { isOverdue } from '../tasks/overdue.ts'
import { pageMain } from '../ui/layout.ts'
import { PageHeader } from '../ui/PageHeader.tsx'
import { buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { ActionError, EmptyState, ErrorState } from '../ui/states.tsx'
import { useMembers } from '../data/useMembers.ts'
import { useMilestones, useMilestoneSections, useSetSectionDrafted } from '../data/useMilestones.ts'
import { useRealtimeTaskDependencies } from '../data/useRealtimeTaskDependencies.ts'
import { useRealtimeTasks } from '../data/useRealtimeTasks.ts'
import { useRealtimeMilestones } from '../data/useRealtimeMilestones.ts'
import { useRealtimeMilestoneSections } from '../data/useRealtimeMilestoneSections.ts'
import { useSubteams } from '../data/useSubteams.ts'
import { useTaskActor } from '../data/useTaskActor.ts'
import { useTaskDependencies } from '../data/useTaskDependencies.ts'
import { useTasksForProgress } from '../data/useTaskHistory.ts'
import { useTasks, useUpdateTask, type Task } from '../data/useTasks.ts'
import { GanttLegend } from './gantt/GanttLegend.tsx'
import { GanttToolbar } from './gantt/GanttToolbar.tsx'
import { MilestoneRow } from './gantt/MilestoneRow.tsx'
import type { GanttEnv } from './gantt/ganttEnv.ts'
import { currentTargetKey, linkEdit, targetKey, unlinkMilestoneEdit, unlinkSectionEdit, type LinkTarget } from './gantt/ganttLinking.ts'
import { planScheduleEdit } from './board/taskEditPlan.ts'
import { subsectionsOf, topLevelSections } from './milestones/milestoneModel.ts'
import { planningDates, taskMark } from './gantt/ganttMarks.ts'
import { monthTicks, placeDay, timelineRange, weekTicks } from './gantt/ganttModel.ts'
import type { ProgressRow } from './gantt/ganttProgress.ts'
import { useUrlParams } from '../lib/useUrlParams.ts'

const SCOPES = [
  { value: 'all' as const, label: 'All tasks' },
  { value: 'mine' as const, label: 'My tasks' },
]

// The composition shell: fetches data, holds the open/closed sets, the scale and
// the department lens, computes the shared timeline range and today-line
// position, and renders one MilestoneRow per milestone. How a row draws itself
// lives in gantt/MilestoneRow.tsx, SectionRow.tsx, UnsectionedRow.tsx and
// GanttTaskRow.tsx; this file is interaction orchestration, not rendering.
//
// The Gantt cannot create tasks (source §30): the only work-association commands
// are link, unlink-section and unlink-milestone on EXISTING Board tasks, and the
// database re-checks who may do each (can_edit_task) and that the milestone,
// section and season agree.
export default function Gantt() {
  const auth = useAuth()
  const seasonId = useSeasonId()
  const milestones = useMilestones()
  const sections = useMilestoneSections(milestones.data?.map((m) => m.key))
  const tasks = useTasks()
  const progress = useTasksForProgress()
  const members = useMembers()
  const departments = useSubteams()
  const actor = useTaskActor()
  const setDrafted = useSetSectionDrafted()
  const updateTask = useUpdateTask()
  useRealtimeTasks()
  useRealtimeTaskDependencies()
  const dependencies = useTaskDependencies()
  useRealtimeMilestones()
  useRealtimeMilestoneSections()
  const [params, setParams] = useUrlParams()

  // Collapsed to start with: the screen's first job is the submissions, and you
  // open the level you care about. What is open lives in the address (?open=,
  // ?sections=, ?task=), so it survives a refresh and a link from Milestones or
  // a Board card lands on the right group already expanded.
  const openMilestones = useMemo(() => readSetParam(params, 'open'), [params])
  const openSections = useMemo(() => readSetParam(params, 'sections'), [params])
  const expandedTask = params.get('task')
  const scale: 'month' | 'week' = params.get('scale') === 'week' ? 'week' : 'month'
  const [legendOpen, setLegendOpen] = useState(false)
  const legendId = useId()
  const writeParams = (patch: Record<string, string | null>) =>
    setParams((current) => mergeSearchParams(current, patch), { replace: true })
  const setOpenMilestones = (next: ReadonlySet<string>) => writeParams({ open: writeSetParam(next) })
  const setOpenSections = (next: ReadonlySet<string>) => writeParams({ sections: writeSetParam(next) })
  const setScale = (next: 'month' | 'week') => writeParams({ scale: next === 'week' ? 'week' : null })

  // A move to ANOTHER submission changes the task's milestone and section
  // together, so it is confirmed first (the same rule LinkTaskTool follows).
  const [pendingMove, setPendingMove] = useState<{ task: Task; target: LinkTarget; label: string } | null>(null)
  const [moveNotice, setMoveNotice] = useState<string | null>(null)
  const moveTitleId = useId()

  const toggle = (set: ReadonlySet<string>, key: string) => {
    const next = new Set(set)
    if (!next.delete(key)) next.add(key)
    return next
  }

  // One calendar day for the whole screen, in the reader's own zone.
  const today = todayIso()
  const myId = auth.status === 'member' ? auth.member.id : null
  const milestoneRows = useMemo(() => milestones.data ?? [], [milestones.data])
  const sectionRows = useMemo(() => sections.data ?? [], [sections.data])
  const taskRows = useMemo(() => tasks.data ?? [], [tasks.data])
  // Falls back to the active list until the archived part has loaded.
  const progressRows = useMemo(() => (progress.data ?? taskRows) as ProgressRow[], [progress.data, taskRows])

  // The lens lives in the address, like the Board's filter, and uses the same
  // shared control, parsing and "My tasks" meaning (owner = the viewer).
  const departmentList = departments.data
  const { filter, notice } = useMemo(() => {
    if (!departmentList) {
      const raw = params.get('dept')
      return {
        filter: { scope: params.get('scope') === 'mine' ? ('mine' as const) : ('all' as const), department: raw ?? 'all' } satisfies TaskFilter,
        notice: null,
      }
    }
    return taskFilterFromParams(params, departmentList)
  }, [params, departmentList])
  // Merged into the address: a filter change keeps what is open and ?task=.
  const setFilter = (next: TaskFilter) => setParams((current) => applyTaskFilter(current, next), { replace: true })
  const choices = useMemo(
    () => departmentChoices(departmentList ?? [], new Set([filter.department])),
    [departmentList, filter.department],
  )
  const lensActive = !isDefaultTaskFilter(filter)
  const departmentLabel = filter.department === 'all' ? null : (choices.find((c) => c.key === filter.department)?.label ?? filter.department)
  const lensName =
    departmentLabel && filter.scope === 'mine' ? `My ${departmentLabel} tasks` : departmentLabel ? departmentLabel : filter.scope === 'mine' ? 'My tasks' : 'All tasks'
  const counts = useMemo(() => taskScopeCounts(taskRows, filter.department, myId), [taskRows, filter.department, myId])
  // Linked tasks each department entry would show under the current scope.
  const departmentCounts = useMemo(() => {
    const inScope = filterTasks(
      taskRows.filter((t) => t.milestone_key !== null || t.section_id !== null),
      { scope: filter.scope, department: 'all' },
      myId,
    )
    const out: Record<string, number> = { all: inScope.length }
    for (const task of inScope) if (task.subteam_key) out[task.subteam_key] = (out[task.subteam_key] ?? 0) + 1
    return out
  }, [taskRows, filter.scope, myId])

  const departmentNames = useMemo(() => new Map((departmentList ?? []).map((d) => [d.key, d.name])), [departmentList])
  const memberNames = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.full_name])), [members.data])
  const sectionNames = useMemo(() => new Map(sectionRows.map((s) => [s.id, s.name])), [sectionRows])

  // Everything the chart must fit: milestone windows and deadlines AND task
  // starts and ends. Only tasks that are actually linked to a submission count,
  // so a loose Board task's date does not stretch the timeline.
  const linked = useMemo(() => taskRows.filter((t) => t.milestone_key !== null || t.section_id !== null), [taskRows])
  const range = timelineRange(planningDates(milestoneRows, linked), today)
  const ticks = scale === 'week' ? weekTicks(range) : monthTicks(range)
  // Weeks need room to be legible; the chart already scrolls sideways.
  const chartWidth = scale === 'week' ? `${Math.max(52, ticks.length * 3.5)}rem` : '52rem'
  const todayLeft = placeDay(today, range)

  // Every place a task can be moved to, in timeline order: each section, then
  // the submission's unsectioned group.
  const moveTargets = useMemo(() => {
    const out: { key: string; label: string; target: LinkTarget }[] = []
    for (const m of milestoneRows) {
      for (const section of topLevelSections(sectionRows, m.key)) {
        const target = { seasonId: seasonId ?? '', milestoneKey: m.key, sectionId: section.id }
        out.push({ key: targetKey(target), label: `${milestoneLabel(m)} · ${section.name}`, target })
        for (const sub of subsectionsOf(sectionRows, section.id)) {
          const subTarget = { seasonId: seasonId ?? '', milestoneKey: m.key, sectionId: sub.id }
          out.push({ key: targetKey(subTarget), label: `${milestoneLabel(m)} · ${section.name} › ${sub.name}`, target: subTarget })
        }
      }
      const loose = { seasonId: seasonId ?? '', milestoneKey: m.key, sectionId: null }
      out.push({ key: targetKey(loose), label: `${milestoneLabel(m)} · no section`, target: loose })
    }
    return out
  }, [milestoneRows, sectionRows, seasonId])

  const dependencyLinks = useMemo(() => dependencies.data ?? [], [dependencies.data])
  const milestoneLabelFor = (key: string | null) => {
    const m = (milestones.data ?? []).find((candidate) => candidate.key === key)
    return m ? milestoneLabel(m) : (key ?? 'no submission')
  }
  // Prerequisites are read by name even once archived (the progress list carries the archived tasks).
  const prerequisiteLookup = useMemo(
    () => taskRefLookup(taskRows, (progress.data ?? []).filter((t) => t.archived_at !== null)),
    [taskRows, progress.data],
  )

  const env: GanttEnv = {
    today,
    range,
    todayLeft,
    seasonId: seasonId ?? '',
    members: members.data ?? [],
    memberNames,
    departmentNames,
    sectionNames,
    permsFor: (task: Task) => {
      if (!actor) return { canEdit: false, canReassign: false }
      const canEdit = canEditTask(actor, task)
      return { canEdit, canReassign: canEdit && canReassignTaskOwner(actor, task) }
    },
    lens: {
      active: lensActive,
      name: lensName,
      matches: (t) => filterTasks([t], filter, myId).length > 0,
    },
    moveTargets,
    onMoveTo: (task, target) => {
      setMoveNotice(null)
      if (!actor || !canEditTask(actor, task)) {
        setMoveNotice(`You cannot move “${task.title}”: only its owner or its department's Head can.`)
        return
      }
      if (targetKey(target) === currentTargetKey(task)) return
      const label = moveTargets.find((t) => t.key === targetKey(target))?.label ?? target.milestoneKey
      if (task.milestone_key !== null && task.milestone_key !== target.milestoneKey) {
        setPendingMove({ task, target, label })
        return
      }
      updateTask.mutate(linkEdit(task, target))
    },
    onSchedule: async (task, start, due) => {
      const plan = planScheduleEdit(task, start, due)
      if (plan.kind === 'invalid') throw new Error(plan.reason)
      if (plan.kind === 'unchanged') return 'Nothing to save — the dates are the same.'
      await updateTask.mutateAsync(plan.edit)
      return `Saved: ${plan.changed.join(', ')}.`
    },
    expandedTask,
    onToggleTask: (taskId) => writeParams({ task: expandedTask === taskId ? null : taskId }),
    prerequisitesFor: (task) => prerequisitesOf(dependencyLinks, task.id, prerequisiteLookup),
    onMove: (taskId, state, blockedReason) =>
      updateTask.mutate({ id: taskId, state, ...(blockedReason ? { blockedReason } : {}) }),
    onOwner: (taskId, ownerId) => updateTask.mutate({ id: taskId, ownerId }),
    onLink: (task, target) => updateTask.mutate(linkEdit(task, target)),
    onUnlinkSection: (task) => updateTask.mutate(unlinkSectionEdit(task)),
    onUnlinkMilestone: (task) => updateTask.mutate(unlinkMilestoneEdit(task)),
  }

  const error = milestones.error ?? sections.error ?? tasks.error
  if (error) {
    return (
      <main id="main-content" tabIndex={-1} className={pageMain()}>
        <h1 className="text-xl font-semibold text-slate-900">Gantt</h1>
        <div className="mt-4">
          <ErrorState
            title="Could not load the Gantt"
            error={error}
            onRetry={() => {
              void milestones.refetch()
              void sections.refetch()
              void tasks.refetch()
            }}
          />
        </div>
      </main>
    )
  }

  const allOpen = openMilestones.size === milestoneRows.length && milestoneRows.length > 0
  const undated = linked.filter((t) => taskMark(t, today).kind === 'undated').length
  const late = linked.filter((t) => isOverdue(t, today)).length
  const upcoming = milestoneRows
    .filter((m): m is typeof m & { due_on: string } => m.due_on !== null && m.due_on >= today)
    .sort((a, b) => a.due_on.localeCompare(b.due_on))[0]

  return (
    <main id="main-content" tabIndex={-1} className={pageMain()}>
      <PageHeader
        title="Gantt"
        description="Every submission on one timeline. Open a submission for its sections and unsectioned work, and a section for its subtasks — which are Board tasks, not copies."
        tutorialId="gantt-header"
      />

      <DepartmentNav choices={choices} value={filter.department} counts={departmentCounts} testId="gantt-departments" />

      {(milestones.isLoading || tasks.isLoading) && (
        <p role="status" className="mb-2 text-xs text-slate-500">Loading…</p>
      )}
      <ActionError error={updateTask.error ?? setDrafted.error} className="mb-3" />
      {moveNotice && (
        <p role="alert" className="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950" data-testid="gantt-move-notice">
          {moveNotice}
        </p>
      )}

      {!milestones.isLoading && milestoneRows.length === 0 ? (
        <EmptyState title="No submissions for this season yet">
          The President or Vice President adds the submission windows in Settings →
          Milestone dates and points. They appear here as soon as they exist.
        </EmptyState>
      ) : (
        <>
          <p className="mb-2 text-sm text-slate-700" data-testid="gantt-summary">
            {milestoneRows.length} submission{milestoneRows.length === 1 ? '' : 's'}.{' '}
            {upcoming ? `Next deadline: ${milestoneLabel(upcoming)} on ${formatDay(upcoming.due_on)}. ` : 'No upcoming deadline is published. '}
            {linked.length} linked task{linked.length === 1 ? '' : 's'}
            {linked.length > 0 ? ` (${undated} undated, ${late} overdue)` : ''}. Progress counts archived done work, so
            archiving a finished task does not lower it.
          </p>

          {/* The department lens: the same control, scope and department as the
              Board. It filters the tasks shown while the milestone → section
              structure stays; each submission's OVERALL progress does not move. */}
          <div className="mb-3 rounded-lg border border-slate-200 bg-white p-3" data-testid="gantt-filters">
            <ScopeDepartmentFilter
              scopes={myId ? SCOPES : [SCOPES[0]]}
              scope={myId ? filter.scope : 'all'}
              onScope={(scope) => setFilter({ ...filter, scope })}
              counts={counts}
              scopeGroupLabel="Which tasks to show"
              scopeTestId="gantt-scope"
            />
            {notice && (
              <p role="status" className="mt-2 text-xs text-amber-900" data-testid="gantt-filter-notice">
                {notice}
              </p>
            )}
            <p className="mt-2 text-xs text-slate-600" data-testid="gantt-lens-note">
              {lensActive
                ? `Showing ${lensName}. Each submission keeps its overall progress; the department figure beside it counts only these tasks.`
                : 'Showing every linked task. Pick a department to see one department’s work in the same structure.'}
            </p>
          </div>

          <GanttToolbar
            allOpen={allOpen}
            onToggleAll={() =>
              setOpenMilestones(allOpen ? new Set() : new Set(milestoneRows.map((m) => m.key)))
            }
            scale={scale}
            onScale={setScale}
            legendOpen={legendOpen}
            legendId={legendId}
            onLegend={() => setLegendOpen((open) => !open)}
          />
          {legendOpen && <GanttLegend id={legendId} />}

          {/* The chart keeps its proportions rather than squeezing; on a phone
              it scrolls sideways, which beats months three pixels wide. It is a
              focusable region so a keyboard user can scroll it. */}
          <div
            role="region"
            aria-label="Timeline, scrolls sideways"
            tabIndex={0}
            className="overflow-x-auto rounded-lg border border-slate-200 bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
          >
            {/* The padding lives inside the scrolled content, so the sticky
                label column has no gap for the ruler to show through. */}
            <div className="p-3" style={{ minWidth: chartWidth }} data-tutorial="gantt-chart">
              <div className="grid grid-cols-[minmax(15rem,22rem)_1fr] items-start gap-3 border-b border-slate-200 pb-1">
                <span className="sticky left-0 z-10 self-stretch flex items-center bg-white pr-2 text-xs font-medium text-slate-600">
                  Submission · section · subtask
                </span>
                <div>
                  {/* Today gets a word as well as a line: nothing is colour-only. */}
                  <div className="relative h-4" data-testid="gantt-today-label">
                    {todayLeft !== null && (
                      <span
                        className="absolute top-0 -translate-x-1/2 rounded bg-red-700 px-1 text-[10px] font-semibold leading-4 text-white"
                        style={{ left: `${todayLeft}%` }}
                      >
                        Today
                      </span>
                    )}
                  </div>
                  <div className="relative h-5" data-testid="gantt-months">
                    {ticks.map((tick) => (
                      <span
                        key={tick.key}
                        className="absolute top-0 truncate border-l border-slate-200 px-1 text-center text-[11px] text-slate-500"
                        style={{ left: `${tick.left}%`, width: `${tick.width}%` }}
                      >
                        {tick.label}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <ul>
                {milestoneRows.map((milestone) => (
                  <MilestoneRow
                    key={milestone.key}
                    milestone={milestone}
                    sections={sectionRows}
                    tasks={taskRows}
                    progressTasks={progressRows}
                    open={openMilestones.has(milestone.key)}
                    onToggle={() => setOpenMilestones(toggle(openMilestones, milestone.key))}
                    openSections={openSections}
                    onToggleSection={(key) => setOpenSections(toggle(openSections, key))}
                    onDraftedChange={(id, isDrafted) => setDrafted.mutate({ id, isDrafted })}
                    env={env}
                  />
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
      <Dialog open={pendingMove !== null} onClose={() => setPendingMove(null)} labelledBy={moveTitleId}>
        {pendingMove && (
          <div data-testid="gantt-move-confirm">
            <h2 id={moveTitleId} className="text-base font-semibold text-slate-900">
              Move to another submission?
            </h2>
            <p className="mt-2 text-sm text-slate-700">
              “{pendingMove.task.title}” is on {milestoneLabelFor(pendingMove.task.milestone_key)}. Moving it to {pendingMove.label} changes its
              milestone and section together, in one change. It stays the same Board task, with the same owner and
              department.
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" className={buttonSecondary} onClick={() => setPendingMove(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={buttonPrimary}
                onClick={() => {
                  updateTask.mutate(linkEdit(pendingMove.task, pendingMove.target))
                  setPendingMove(null)
                }}
              >
                Move it
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </main>
  )
}
