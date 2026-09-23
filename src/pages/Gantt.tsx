import { useState } from 'react'
import { usePermissions } from '../auth/usePermissions.ts'
import { todayIso } from '../lib/dates.ts'
import { pageMain } from '../ui/layout.ts'
import { PageHeader } from '../ui/PageHeader.tsx'
import { ActionError, EmptyState, ErrorState } from '../ui/states.tsx'
import { useMembers } from '../data/useMembers.ts'
import { useMilestones, useMilestoneSections, useSetSectionDrafted } from '../data/useMilestones.ts'
import { useAddSectionTask, useTasks, useUpdateTask, type TaskState } from '../data/useTasks.ts'
import { GanttToolbar } from './gantt/GanttToolbar.tsx'
import { MilestoneRow } from './gantt/MilestoneRow.tsx'
import { monthTicks, placeDay, timelineRange, weekTicks } from './gantt/ganttModel.ts'

// The composition shell (Phase 6 §6.3): fetches data, holds the open/closed
// sets and the scale, computes the shared timeline range and today-line
// position, and renders one MilestoneRow per milestone. Everything about how
// a single row draws itself — and the section/subtask levels under it — lives
// in gantt/MilestoneRow.tsx, gantt/SectionRow.tsx and gantt/GanttTaskRow.tsx;
// this file is interaction orchestration, not rendering detail.
export default function Gantt() {
  const can = usePermissions()
  const milestones = useMilestones()
  const sections = useMilestoneSections(milestones.data?.map((m) => m.key))
  const tasks = useTasks()
  const members = useMembers()
  const setDrafted = useSetSectionDrafted()
  const updateTask = useUpdateTask()
  const addTask = useAddSectionTask()

  // Collapsed to start with: the screen's first job is the submissions, and you
  // open the level you care about.
  const [openMilestones, setOpenMilestones] = useState<ReadonlySet<string>>(new Set())
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(new Set())
  const [scale, setScale] = useState<'month' | 'week'>('month')

  const toggle = (set: ReadonlySet<string>, key: string) => {
    const next = new Set(set)
    if (!next.delete(key)) next.add(key)
    return next
  }

  const today = todayIso()
  const now = new Date()
  const milestoneRows = milestones.data ?? []
  const sectionRows = sections.data ?? []
  const taskRows = tasks.data ?? []

  // Not memoized: it is one pass over a handful of milestones and however many
  // tasks the season has, which is cheaper than the bookkeeping to cache it.
  const range = timelineRange(
    [...milestoneRows.flatMap((m) => [m.opens_on, m.due_on]), ...taskRows.map((t) => t.due_date)],
    today,
  )
  const ticks = scale === 'week' ? weekTicks(range) : monthTicks(range)
  // Weeks need room to be legible; the chart already scrolls sideways.
  const chartWidth = scale === 'week' ? `${Math.max(52, ticks.length * 3.5)}rem` : '52rem'
  const todayLeft = placeDay(today, range)
  const unlinked = taskRows.filter((t) => t.section_id === null)

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

  return (
    <main id="main-content" tabIndex={-1} className={pageMain()}>
      <PageHeader
        title="Gantt"
        description="Every submission on one timeline. Open a submission for its sections, and a section for its subtasks — which are Board tasks, not copies."
        tutorialId="gantt-header"
      />

      {(milestones.isLoading || tasks.isLoading) && (
        <p role="status" className="mb-2 text-xs text-slate-500">Loading…</p>
      )}
      <ActionError error={addTask.error ?? updateTask.error ?? setDrafted.error} className="mb-3" />

      {!milestones.isLoading && milestoneRows.length === 0 ? (
        <EmptyState title="No submissions for this season yet">
          The President or Vice President adds the submission windows in Settings →
          Milestone dates and points. They appear here as soon as they exist.
        </EmptyState>
      ) : (
        <>
          <GanttToolbar
            allOpen={allOpen}
            onToggleAll={() =>
              setOpenMilestones(allOpen ? new Set() : new Set(milestoneRows.map((m) => m.key)))
            }
            scale={scale}
            onScale={setScale}
          />

          {/* The chart keeps its proportions rather than squeezing; on a phone
              it scrolls sideways, which beats months three pixels wide. */}
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            {/* The padding lives inside the scrolled content, so the sticky
                label column has no gap for the ruler to show through. */}
            <div className="p-3" style={{ minWidth: chartWidth }} data-tutorial="gantt-chart">
              <div className="grid grid-cols-[minmax(15rem,22rem)_1fr] items-start gap-3 border-b border-slate-200 pb-1">
                <span className="sticky left-0 z-10 self-stretch flex items-center bg-white pr-2 text-xs font-medium text-slate-600">
                  Submission · section · subtask
                </span>
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

              <ul>
                {milestoneRows.map((milestone) => (
                  <MilestoneRow
                    key={milestone.key}
                    milestone={milestone}
                    sections={sectionRows}
                    tasks={taskRows}
                    unlinked={unlinked}
                    range={range}
                    todayLeft={todayLeft}
                    open={openMilestones.has(milestone.key)}
                    onToggle={() => setOpenMilestones(toggle(openMilestones, milestone.key))}
                    openSections={openSections}
                    onToggleSection={(sectionId) => setOpenSections(toggle(openSections, sectionId))}
                    members={members.data ?? []}
                    onDraftedChange={(id, isDrafted) => setDrafted.mutate({ id, isDrafted })}
                    canCreateTask={can.canAssignTask}
                    addingTask={addTask.isPending}
                    onCreateTask={(sectionId, title) => addTask.mutate({ sectionId, title })}
                    onLinkTask={(sectionId, taskId) => updateTask.mutate({ id: taskId, sectionId })}
                    onMoveTask={(taskId, state: TaskState) => updateTask.mutate({ id: taskId, state })}
                    onOwnerTask={(taskId, ownerId) => updateTask.mutate({ id: taskId, ownerId })}
                    onUnlinkTask={(taskId) => updateTask.mutate({ id: taskId, sectionId: null })}
                    now={now}
                  />
                ))}
              </ul>
            </div>
          </div>
        </>
      )}
    </main>
  )
}
