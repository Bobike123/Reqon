import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Member } from '../../data/useMembers.ts'
import type { Task, TaskState } from '../../data/useTasks.ts'
import { formatDay } from '../../lib/dates.ts'
import { TASK_STATES, TASK_STATE_LABEL } from '../../tasks/taskState.ts'
import { isUrgent, TASK_PRIORITY_BADGE_TONE, TASK_PRIORITY_LABEL } from '../../tasks/priority.ts'
import { buttonSecondary } from '../../ui/buttons.ts'
import { Bar, Marker, ROW, STICKY_LABEL, selectSmall, Track } from './GanttChart.tsx'
import type { LinkTarget } from './ganttLinking.ts'
import { taskMark, taskSummary } from './ganttMarks.ts'
import type { Span } from './ganttModel.ts'
import { ScheduleHandles, type ScheduleDates } from './ScheduleHandles.tsx'
import { TASK_DRAG_TYPE } from './ganttDrag.ts'

export type GanttTaskPerms = { canEdit: boolean; canReassign: boolean }

// What "Unlink" does here: a real action, or the reason there is none.
export type UnlinkOption =
  | { kind: 'action'; label: string; onUnlink: () => void }
  | { kind: 'kept'; reason: string }

// The drag payload type: a task id, and nothing else. Drops are re-checked by
// the database like any other link (can_edit_task + the consistency trigger).
type MoveTarget = { key: string; label: string; target: LinkTarget }

const FIELD =
  'mt-0.5 min-h-11 w-full rounded border border-slate-300 bg-white px-1.5 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'

// A readable status cue beside the title: words, plus a symbol, never colour
// alone. Overdue and Blocked are the two that need attention.
function StatusCue({ task, overdue }: { task: Task; overdue: boolean }) {
  if (task.state === 'blocked') return <span className="rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-900">⏸ Blocked</span>
  if (task.state === 'done') return <span className="rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-600">✓ Done</span>
  if (overdue) return <span className="rounded bg-red-100 px-1 text-[10px] font-semibold text-red-800">! Overdue</span>
  return null
}

// One task under a section, or under a submission's unsectioned work. It is the
// Board task itself (the title opens its Board card) — never a copy — drawn as a
// period, a deadline marker or nothing, according to which dates it really has.
// It expands into its facts, its dates (editable where allowed — the keyboard
// alternative to dragging the bar) and a "Move to" choice (the alternative to
// dragging the row onto another section). Controls appear only where this
// person may use them; everyone can read it.
export function GanttTaskRow({
  task,
  today,
  departmentName,
  ownerName,
  members,
  range,
  todayLeft,
  perms,
  unlink,
  indent = 'pl-12',
  expanded,
  onToggle,
  moveTargets,
  currentTargetKey,
  onMoveTo,
  onSchedule,
  onMove,
  onOwner,
}: {
  task: Task
  today: string
  departmentName: string | null
  ownerName: string | null
  members: Member[]
  range: Span
  todayLeft: number | null
  perms: GanttTaskPerms
  unlink: UnlinkOption | null
  indent?: string
  expanded: boolean
  onToggle: () => void
  moveTargets: MoveTarget[]
  currentTargetKey: string
  onMoveTo: (target: LinkTarget) => void
  onSchedule: (start: string | null, due: string | null) => Promise<string>
  onMove: (state: TaskState) => void
  onOwner: (ownerId: string | null) => void
}) {
  const uid = useId()
  const [preview, setPreview] = useState<ScheduleDates | null>(null)
  const [start, setStart] = useState(task.starts_on ?? '')
  const [due, setDue] = useState(task.due_date ?? '')
  const [seen, setSeen] = useState({ s: task.starts_on, d: task.due_date })
  const [dateResult, setDateResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  // Someone (or a drag) changed the dates: the fields follow the saved values.
  if (seen.s !== task.starts_on || seen.d !== task.due_date) {
    setSeen({ s: task.starts_on, d: task.due_date })
    setStart(task.starts_on ?? '')
    setDue(task.due_date ?? '')
  }

  const drawn = preview ? { ...task, starts_on: preview.start, due_date: preview.due } : task
  const mark = taskMark(drawn, today)
  const summary = taskSummary(task, today)
  const overdue = 'overdue' in mark && mark.overdue

  const schedule = async (s: string | null, d: string | null) => {
    setSaving(true)
    setDateResult(null)
    try {
      const what = await onSchedule(s, d)
      setDateResult({ ok: true, text: what })
    } catch (e) {
      setDateResult({ ok: false, text: e instanceof Error ? e.message : 'The dates were not saved.' })
    } finally {
      setSaving(false)
      setPreview(null)
    }
  }

  return (
    <div data-testid={`gantt-task-${task.id}`} data-task-state={task.state}>
      <div className={`${ROW} group py-1`}>
        <div
          className={`${STICKY_LABEL} flex flex-wrap items-center gap-1 bg-white ${indent} pr-2 group-hover:bg-slate-100`}
          draggable={perms.canEdit}
          onDragStart={(event) => {
            event.dataTransfer.setData(TASK_DRAG_TYPE, task.id)
            event.dataTransfer.effectAllowed = 'move'
          }}
        >
          <span className="flex w-full flex-wrap items-center gap-1.5 text-xs text-slate-700">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={`${uid}-more`}
              onClick={onToggle}
              className="flex min-h-11 min-w-6 items-center justify-center rounded text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            >
              <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
              <span className="sr-only">{expanded ? 'Hide' : 'Show'} details of {task.title}</span>
            </button>
            {perms.canEdit && (
              <span aria-hidden="true" title="Drag onto another section to move it" className="cursor-grab text-slate-400">
                ⠿
              </span>
            )}
            <Link
              to={`/board?task=${encodeURIComponent(task.id)}`}
              className="min-h-11 py-2 underline decoration-slate-400 underline-offset-2 hover:decoration-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0 sm:py-0"
            >
              {task.title}
            </Link>
            {isUrgent(task.priority) && (
              <span className={`rounded px-1 py-0.5 text-[10px] font-bold uppercase ${TASK_PRIORITY_BADGE_TONE.urgent}`}>
                {TASK_PRIORITY_LABEL.urgent}
              </span>
            )}
            <StatusCue task={task} overdue={overdue} />
            <span className="text-[11px] text-slate-500">{departmentName ?? 'No department'}</span>
          </span>

          {perms.canEdit ? (
            <>
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
            </>
          ) : (
            <span className="text-[11px] font-medium text-slate-700" data-testid={`gantt-state-text-${task.id}`}>
              {TASK_STATE_LABEL[task.state]}
            </span>
          )}

          {perms.canReassign ? (
            <>
              <label className="sr-only" htmlFor={`gantt-owner-${task.id}`}>
                Owner for {task.title}
              </label>
              <select
                id={`gantt-owner-${task.id}`}
                value={task.owner_id ?? ''}
                onChange={(e) => onOwner(e.target.value || null)}
                className={`${selectSmall} max-w-40`}
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <span className="text-[11px] text-slate-600">{ownerName ?? 'Unassigned'}</span>
          )}

          {/* Unlinking leaves the task on the Board. Deleting one is not possible at all. */}
          {unlink?.kind === 'action' && (
            <button
              type="button"
              onClick={unlink.onUnlink}
              aria-label={unlink.label}
              className="min-h-11 rounded px-1 text-[11px] text-slate-600 underline underline-offset-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            >
              Unlink
            </button>
          )}
          {unlink?.kind === 'kept' && <span className="text-[11px] text-slate-500">{unlink.reason}</span>}
        </div>

        <Track today={todayLeft} label={mark.kind === 'undated' ? 'No dates set' : undefined} summary={summary}>
          {mark.kind === 'period' && (
            <Bar
              span={mark.span}
              range={range}
              variant="outline"
              tone={mark.overdue ? 'border-red-600 text-red-800' : mark.done ? 'border-slate-400 text-slate-600' : 'border-slate-600 text-slate-800'}
              glyph={mark.done ? '✓' : mark.overdue ? '!' : undefined}
              title={`${task.title}: ${formatDay(mark.span.from)} → ${formatDay(mark.span.to)}${mark.overdue ? ' · overdue' : ''}`}
            />
          )}
          {mark.kind === 'deadline' && (
            <Marker
              day={mark.day}
              range={range}
              kind="task-deadline"
              overdue={mark.overdue}
              done={mark.done}
              title={`${task.title}: due ${formatDay(mark.day)}${mark.overdue ? ' · overdue' : ''}`}
            />
          )}
          {mark.kind === 'start-only' && (
            <Marker
              day={mark.day}
              range={range}
              kind="task-start"
              done={mark.done}
              title={`${task.title}: starts ${formatDay(mark.day)} (no deadline)`}
            />
          )}
          {perms.canEdit && !saving && (
            <ScheduleHandles
              dates={{ start: task.starts_on, due: task.due_date }}
              range={range}
              title={task.title}
              onPreview={setPreview}
              onCommit={(next) => {
                setPreview(next)
                void schedule(next.start, next.due)
              }}
            />
          )}
          {preview && (
            <span className="absolute -top-0.5 right-1 z-[3] rounded bg-slate-900 px-1 text-[10px] text-white" aria-hidden="true">
              {preview.start ? formatDay(preview.start) : '—'} → {preview.due ? formatDay(preview.due) : '—'}
            </span>
          )}
        </Track>
      </div>

      {expanded && (
        <div id={`${uid}-more`} className="sticky left-0 z-10 mb-2 ml-6 w-[min(42rem,calc(100vw-2.5rem))] rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700 sm:ml-12" data-testid={`gantt-task-more-${task.id}`}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt className="font-medium">Start date</dt>
            <dd>{task.starts_on ? formatDay(task.starts_on) : 'Not recorded'}</dd>
            <dt className="font-medium">Deadline</dt>
            <dd className={overdue ? 'font-semibold text-red-700' : undefined}>
              {task.due_date ? `${formatDay(task.due_date)}${overdue ? ' — overdue' : ''}` : 'Not set'}
            </dd>
            <dt className="font-medium">Status</dt>
            <dd>{TASK_STATE_LABEL[task.state]}</dd>
            <dt className="font-medium">Owner</dt>
            <dd>{ownerName ?? 'Unassigned'}</dd>
            <dt className="font-medium">Department</dt>
            <dd>{departmentName ?? 'No department'}</dd>
          </dl>
          <p className="mt-1 text-[11px] text-slate-500">
            Only the task&apos;s own start date and deadline are drawn. The day it was added to the Board is not a start
            date, and nothing is estimated.
          </p>
          {task.state === 'blocked' && (
            <p className="mt-1 rounded border-l-4 border-amber-500 bg-amber-50 px-1.5 py-0.5 text-amber-950">
              Blocked — no reason or prerequisite is recorded (Reqon has no dependency links yet).
            </p>
          )}

          {perms.canEdit ? (
            <>
              <div
                role="group"
                aria-label={`Dates for ${task.title}`}
                className="mt-2 flex flex-wrap items-end gap-2"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
                    e.preventDefault()
                    void schedule(start || null, due || null)
                  }
                }}
              >
                <div>
                  <label htmlFor={`${uid}-start`} className="block font-medium">
                    Start date
                  </label>
                  <input id={`${uid}-start`} type="date" value={start} onChange={(e) => setStart(e.target.value)} className={FIELD} />
                </div>
                <div>
                  <label htmlFor={`${uid}-due`} className="block font-medium">
                    Deadline
                  </label>
                  <input id={`${uid}-due`} type="date" value={due} onChange={(e) => setDue(e.target.value)} className={FIELD} />
                </div>
                <button type="button" disabled={saving} onClick={() => void schedule(start || null, due || null)} className={`${buttonSecondary} text-xs`}>
                  {saving ? 'Saving…' : 'Save dates'}
                </button>
              </div>
              {dateResult && (
                <p role={dateResult.ok ? 'status' : 'alert'} className={`mt-1 ${dateResult.ok ? 'text-green-800' : 'text-red-800'}`} data-testid={`gantt-date-result-${task.id}`}>
                  {dateResult.text}
                </p>
              )}

              <div className="mt-2">
                <label htmlFor={`${uid}-moveto`} className="block font-medium">
                  Move to
                </label>
                <select
                  id={`${uid}-moveto`}
                  value={currentTargetKey}
                  onChange={(e) => {
                    const choice = moveTargets.find((t) => t.key === e.target.value)
                    if (choice && choice.key !== currentTargetKey) onMoveTo(choice.target)
                  }}
                  className={`${FIELD} max-w-full sm:w-auto`}
                >
                  {moveTargets.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  The same as dragging the row onto a section. The task keeps its id, owner and department.
                </p>
              </div>
            </>
          ) : (
            <p className="mt-1 text-[11px] text-slate-500">Read-only for you: its owner, its department&apos;s Head or a Developer can change it.</p>
          )}
        </div>
      )}
    </div>
  )
}
