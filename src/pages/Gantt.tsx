import { useState, type ReactNode } from 'react'
import { usePermissions } from '../auth/usePermissions.ts'
import { formatDay, todayIso } from '../lib/dates.ts'
import { buttonSecondary } from '../ui/buttons.ts'
import { pageMain } from '../ui/layout.ts'
import { PageHeader } from '../ui/PageHeader.tsx'
import { ActionError, EmptyState, ErrorState } from '../ui/states.tsx'
import { useMembers } from '../data/useMembers.ts'
import {
  useMilestones,
  useMilestoneSections,
  useSetSectionDrafted,
  type MilestoneSection,
} from '../data/useMilestones.ts'
import {
  useAddSectionTask,
  useTasks,
  useUpdateTask,
  type Task,
  type TaskState,
} from '../data/useTasks.ts'
import { sectionsFor, submissionWindow } from './milestones/milestoneModel.ts'
import {
  milestonePercent,
  milestoneSpan,
  monthTicks,
  placeBar,
  placeDay,
  progressOf,
  sectionPercent,
  sectionSpan,
  tasksInSection,
  timelineRange,
  type Span,
} from './gantt/ganttModel.ts'

// The same six lanes as the Board, because these ARE board tasks. If a seventh
// state is ever added to the enum it belongs in both places — or, better, the
// two lists become one.
const STATES: { state: TaskState; label: string }[] = [
  { state: 'urgent', label: 'Urgent' },
  { state: 'todo', label: 'To do' },
  { state: 'wip', label: 'In progress' },
  { state: 'blocked', label: 'Blocked' },
  { state: 'done', label: 'Done' },
  { state: 'cancelled', label: 'Cancelled' },
]

const BAR_TONE: Record<TaskState, string> = {
  urgent: 'bg-red-500',
  todo: 'bg-slate-400',
  wip: 'bg-blue-500',
  blocked: 'bg-amber-500',
  done: 'bg-green-600',
  cancelled: 'bg-slate-300',
}

// Label column, then the timeline. One constant so all three levels and the
// month ruler share a single left edge — the thing that makes a Gantt readable.
const ROW = 'grid grid-cols-[minmax(15rem,22rem)_1fr] items-start gap-3'

const selectSmall =
  'min-h-11 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'

// The track every bar is drawn in, with the "today" line on top of it. The line
// is repeated per row rather than laid over the whole chart: it then cannot
// drift out of alignment when a row changes height.
function Track({
  today,
  children,
  label,
}: {
  today: number | null
  label?: string
  children?: ReactNode
}) {
  return (
    <div className="relative h-6 rounded bg-slate-50 ring-1 ring-inset ring-slate-100">
      {today !== null && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 w-px bg-red-500/60"
          style={{ left: `${today}%` }}
        />
      )}
      {label && (
        <span className="absolute inset-y-0 left-1 flex items-center text-[11px] text-slate-500">
          {label}
        </span>
      )}
      {children}
    </div>
  )
}

// A bar, with progress filled in from the left. `title` carries the dates: the
// chart shows roughly when, the tooltip says exactly when.
function Bar({
  span,
  range,
  percent,
  tone,
  title,
}: {
  span: Span
  range: Span
  percent?: number
  tone: string
  title: string
}) {
  const box = placeBar(span, range)
  if (!box) return null
  return (
    <span
      title={title}
      className={`absolute inset-y-1 min-w-[3px] overflow-hidden rounded ${tone}`}
      style={{ left: `${box.left}%`, width: `${box.width}%` }}
    >
      {percent !== undefined && percent > 0 && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-slate-900/35"
          style={{ width: `${percent}%` }}
        />
      )}
    </span>
  )
}

// The row under an expanded section: create a board task here, or adopt one
// that already exists. Both end up as the same thing — a task with section_id
// set — which is why there is no third option.
function SubtaskTools({
  section,
  unlinked,
  canCreate,
  onCreate,
  onLink,
  busy,
}: {
  section: MilestoneSection
  unlinked: Task[]
  canCreate: boolean
  onCreate: (title: string) => void
  onLink: (taskId: string) => void
  busy: boolean
}) {
  const [title, setTitle] = useState('')

  return (
    <div className="flex flex-wrap items-center gap-2 py-1 pl-12">
      {canCreate && (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            const trimmed = title.trim()
            if (!trimmed) return
            onCreate(trimmed)
            setTitle('')
          }}
        >
          <label className="sr-only" htmlFor={`add-${section.id}`}>
            New subtask for {section.name}
          </label>
          <input
            id={`add-${section.id}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New subtask…"
            maxLength={200}
            className="min-h-11 w-48 rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          />
          <button type="submit" className={`${buttonSecondary} text-xs`} disabled={busy || !title.trim()}>
            Add to Board
          </button>
        </form>
      )}

      {unlinked.length > 0 && (
        <>
          <label className="sr-only" htmlFor={`link-${section.id}`}>
            Link an existing board task to {section.name}
          </label>
          <select
            id={`link-${section.id}`}
            value=""
            onChange={(e) => e.target.value && onLink(e.target.value)}
            className={selectSmall}
          >
            <option value="">Link an existing task…</option>
            {unlinked.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  )
}

export default function Gantt() {
  const can = usePermissions()
  const milestones = useMilestones()
  const sections = useMilestoneSections()
  const tasks = useTasks()
  const members = useMembers()
  const setDrafted = useSetSectionDrafted()
  const updateTask = useUpdateTask()
  const addTask = useAddSectionTask()

  // Collapsed to start with: the screen's first job is the submissions, and you
  // open the level you care about.
  const [openMilestones, setOpenMilestones] = useState<ReadonlySet<string>>(new Set())
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(new Set())

  const toggle = (set: ReadonlySet<string>, key: string) => {
    const next = new Set(set)
    if (!next.delete(key)) next.add(key)
    return next
  }

  const today = todayIso()
  const milestoneRows = milestones.data ?? []
  const sectionRows = sections.data ?? []
  const taskRows = tasks.data ?? []

  // Not memoized: it is one pass over a handful of milestones and however many
  // tasks the season has, which is cheaper than the bookkeeping to cache it.
  const range = timelineRange(
    [...milestoneRows.flatMap((m) => [m.opens_on, m.due_on]), ...taskRows.map((t) => t.due_date)],
    today,
  )
  const ticks = monthTicks(range)
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
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={`${buttonSecondary} text-xs`}
              onClick={() =>
                setOpenMilestones(allOpen ? new Set() : new Set(milestoneRows.map((m) => m.key)))
              }
            >
              {allOpen ? 'Collapse all' : 'Expand all'}
            </button>
            <p className="text-xs text-slate-500">
              The red line is today. A bar fills from the left as its subtasks are done.
            </p>
          </div>

          {/* The chart keeps its proportions rather than squeezing; on a phone
              it scrolls sideways, which beats months three pixels wide. */}
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-3">
            <div className="min-w-[52rem]" data-tutorial="gantt-chart">
              <div className={`${ROW} border-b border-slate-200 pb-1`}>
                <span className="text-xs font-medium text-slate-600">
                  Submission · section · subtask
                </span>
                <div className="relative h-5" data-testid="gantt-months">
                  {ticks.map((tick) => (
                    <span
                      key={tick.key}
                      className="absolute top-0 truncate border-l border-slate-200 pl-1 text-[11px] text-slate-500"
                      style={{ left: `${tick.left}%`, width: `${tick.width}%` }}
                    >
                      {tick.label}
                    </span>
                  ))}
                </div>
              </div>

              <ul>
                {milestoneRows.map((milestone) => {
                  const mySections = sectionsFor(sectionRows, milestone.key)
                  const span = milestoneSpan(milestone)
                  const window = submissionWindow(milestone, new Date())
                  const percent = milestonePercent(mySections, taskRows)
                  const open = openMilestones.has(milestone.key)

                  return (
                    <li
                      key={milestone.key}
                      className="border-b border-slate-100 py-1 last:border-0"
                      data-testid={`gantt-milestone-${milestone.key}`}
                    >
                      <div className={ROW}>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            aria-expanded={open}
                            onClick={() => setOpenMilestones(toggle(openMilestones, milestone.key))}
                            className="flex min-h-11 items-center gap-1.5 text-left text-sm font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                          >
                            <span aria-hidden="true" className="w-3 text-slate-500">
                              {open ? '▾' : '▸'}
                            </span>
                            <span className="font-mono text-xs">{milestone.key}</span>
                            <span className="font-normal">{milestone.name}</span>
                          </button>
                          <span className="ml-auto shrink-0 text-xs text-slate-600">{percent}%</span>
                        </div>

                        <Track today={todayLeft} label={span ? undefined : 'Window: TBC'}>
                          {span && (
                            <Bar
                              span={span}
                              range={range}
                              percent={percent}
                              tone={
                                window.kind === 'dated' && window.passed && percent < 100
                                  ? 'bg-red-600'
                                  : 'bg-slate-700'
                              }
                              title={`${milestone.key}: ${
                                span.from === span.to ? '' : `${formatDay(span.from)} → `
                              }${formatDay(span.to)} · ${percent}% done`}
                            />
                          )}
                        </Track>
                      </div>

                      {open && mySections.length === 0 && (
                        <p className="py-1 pl-6 text-xs text-slate-500">
                          No sections listed for this submission yet.
                        </p>
                      )}

                      {open &&
                        mySections.map((section) => {
                          const mine = tasksInSection(taskRows, section.id)
                          const progress = progressOf(mine)
                          const sectionBar = sectionSpan(taskRows, section.id, span)
                          const sectionOpen = openSections.has(section.id)

                          return (
                            <div key={section.id} data-testid={`gantt-section-${section.id}`}>
                              <div className={`${ROW} py-0.5`}>
                                <div className="flex items-center gap-1.5 pl-6">
                                  <button
                                    type="button"
                                    aria-expanded={sectionOpen}
                                    onClick={() => setOpenSections(toggle(openSections, section.id))}
                                    className="flex min-h-11 items-center gap-1.5 text-left text-xs text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                                  >
                                    <span aria-hidden="true" className="w-3 text-slate-500">
                                      {sectionOpen ? '▾' : '▸'}
                                    </span>
                                    {section.name}
                                  </button>
                                  {/* The same tick as Milestones, writing to the
                                      same row: one checklist, two screens. */}
                                  <label className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-slate-500">
                                    <input
                                      type="checkbox"
                                      checked={section.is_drafted}
                                      aria-label={`${section.name} drafted`}
                                      onChange={(e) =>
                                        setDrafted.mutate({ id: section.id, isDrafted: e.target.checked })
                                      }
                                      className="h-4 w-4 accent-slate-900"
                                    />
                                    {progress.total > 0 ? `${progress.done}/${progress.total}` : 'drafted'}
                                  </label>
                                </div>

                                <Track today={todayLeft}>
                                  {sectionBar && (
                                    <Bar
                                      span={sectionBar}
                                      range={range}
                                      percent={sectionPercent(section, taskRows)}
                                      tone={mine.length > 0 ? 'bg-slate-500' : 'bg-slate-300'}
                                      title={`${section.name}: ${formatDay(sectionBar.from)} → ${formatDay(
                                        sectionBar.to,
                                      )}${mine.length === 0 ? ' (no dated subtasks — shows the submission window)' : ''}`}
                                    />
                                  )}
                                </Track>
                              </div>

                              {sectionOpen && (
                                <>
                                  {mine.map((task) => (
                                    <div
                                      key={task.id}
                                      className={`${ROW} py-0.5`}
                                      data-testid={`gantt-task-${task.id}`}
                                      data-task-state={task.state}
                                    >
                                      <div className="flex flex-wrap items-center gap-1 pl-12">
                                        <span className="w-full text-xs text-slate-700">{task.title}</span>
                                        <label className="sr-only" htmlFor={`gantt-state-${task.id}`}>
                                          Move {task.title} to another lane
                                        </label>
                                        <select
                                          id={`gantt-state-${task.id}`}
                                          value={task.state}
                                          onChange={(e) =>
                                            updateTask.mutate({
                                              id: task.id,
                                              state: e.target.value as TaskState,
                                            })
                                          }
                                          className={selectSmall}
                                        >
                                          {STATES.map((s) => (
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
                                          onChange={(e) =>
                                            updateTask.mutate({
                                              id: task.id,
                                              ownerId: e.target.value || null,
                                            })
                                          }
                                          className={selectSmall}
                                        >
                                          <option value="">Unassigned</option>
                                          {(members.data ?? []).map((m) => (
                                            <option key={m.id} value={m.id}>
                                              {m.full_name}
                                            </option>
                                          ))}
                                        </select>
                                        {/* Unlinking leaves the task on the Board.
                                            Deleting one is still the Board's job. */}
                                        <button
                                          type="button"
                                          onClick={() => updateTask.mutate({ id: task.id, sectionId: null })}
                                          aria-label={`Unlink ${task.title} from ${section.name}`}
                                          className="min-h-11 rounded px-1 text-[11px] text-slate-500 underline underline-offset-2 hover:text-slate-800 sm:min-h-0"
                                        >
                                          Unlink
                                        </button>
                                      </div>

                                      <Track
                                        today={todayLeft}
                                        label={task.due_date ? undefined : 'No due date'}
                                      >
                                        {task.due_date && (
                                          <Bar
                                            span={{ from: task.due_date, to: task.due_date }}
                                            range={range}
                                            tone={BAR_TONE[task.state]}
                                            title={`${task.title}: due ${formatDay(task.due_date)}`}
                                          />
                                        )}
                                      </Track>
                                    </div>
                                  ))}

                                  {mine.length === 0 && (
                                    <p className="pl-12 text-[11px] text-slate-500">
                                      No subtasks yet. Anything added here is a real Board task.
                                    </p>
                                  )}

                                  <SubtaskTools
                                    section={section}
                                    unlinked={unlinked}
                                    canCreate={can.canAssignTask}
                                    busy={addTask.isPending}
                                    onCreate={(title) =>
                                      addTask.mutate({ sectionId: section.id, title })
                                    }
                                    onLink={(taskId) =>
                                      updateTask.mutate({ id: taskId, sectionId: section.id })
                                    }
                                  />
                                </>
                              )}
                            </div>
                          )
                        })}
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        </>
      )}
    </main>
  )
}
