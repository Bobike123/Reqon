import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { placeBar, placeDay, rangeDays, shiftDay, type Span } from './ganttModel.ts'

export type ScheduleDates = { start: string | null; due: string | null }
type Part = 'move' | 'start' | 'end'

// Pointer handles laid over one task's mark on the timeline: drag the body of a
// period to move both dates, drag either end to change that date alone, drag a
// single-date marker to move it. Nothing is written while dragging — the row
// draws a preview; on release the change goes through the ordinary, authorized
// task date update (useUpdateTask → guard_task_edit), which rolls back and
// reports if the database refuses it.
//
// Pointer only, and hidden from assistive technology: the keyboard and touch
// alternative is the row's own Start date / Deadline fields, which make the same
// change. Offered only to someone who may edit the task.
export function ScheduleHandles({
  dates,
  range,
  title,
  onPreview,
  onCommit,
}: {
  dates: ScheduleDates
  range: Span
  title: string
  onPreview: (dates: ScheduleDates | null) => void
  onCommit: (dates: ScheduleDates) => void
}) {
  const drag = useRef<{ part: Part; x0: number; width: number; moved: ScheduleDates | null } | null>(null)

  const next = (part: Part, delta: number): ScheduleDates => {
    const { start, due } = dates
    if (part === 'move') {
      return { start: start ? shiftDay(start, delta) : null, due: due ? shiftDay(due, delta) : null }
    }
    if (part === 'start' && start) {
      const moved = shiftDay(start, delta)
      return { start: due && moved > due ? due : moved, due }
    }
    if (part === 'end' && due) {
      const moved = shiftDay(due, delta)
      return { start, due: start && moved < start ? start : moved }
    }
    return dates
  }

  const down = (part: Part) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return
    const track = event.currentTarget.parentElement
    if (!track) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { part, x0: event.clientX, width: track.getBoundingClientRect().width, moved: null }
  }
  const move = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const d = drag.current
    if (!d || d.width <= 0) return
    const delta = Math.round(((event.clientX - d.x0) / d.width) * rangeDays(range))
    d.moved = delta === 0 ? null : next(d.part, delta)
    onPreview(d.moved)
  }
  const up = () => {
    const d = drag.current
    drag.current = null
    if (d?.moved) onCommit(d.moved)
    else onPreview(null)
  }
  const cancel = () => {
    drag.current = null
    onPreview(null)
  }
  const handlers = (part: Part) => ({
    onPointerDown: down(part),
    onPointerMove: move,
    onPointerUp: up,
    onPointerCancel: cancel,
    onLostPointerCapture: () => {
      if (drag.current) cancel()
    },
  })
  const handle = 'absolute inset-y-0 z-[2] touch-none'

  if (dates.start && dates.due) {
    const box = placeBar({ from: dates.start, to: dates.due }, range)
    if (!box) return null
    return (
      <>
        <span aria-hidden="true" title={`Drag to move ${title}`} className={`${handle} cursor-grab active:cursor-grabbing`} style={{ left: `${box.left}%`, width: `${box.width}%` }} {...handlers('move')} data-schedule-part="move" />
        <span aria-hidden="true" title={`Drag to change the start of ${title}`} className={`${handle} w-2 -translate-x-1/2 cursor-ew-resize rounded bg-slate-900/20 hover:bg-slate-900/40`} style={{ left: `${box.left}%` }} {...handlers('start')} data-schedule-part="start" />
        <span aria-hidden="true" title={`Drag to change the deadline of ${title}`} className={`${handle} w-2 -translate-x-1/2 cursor-ew-resize rounded bg-slate-900/20 hover:bg-slate-900/40`} style={{ left: `${box.left + box.width}%` }} {...handlers('end')} data-schedule-part="end" />
      </>
    )
  }
  const day = dates.due ?? dates.start
  if (!day) return null
  const left = placeDay(day, range)
  if (left === null) return null
  return (
    <span
      aria-hidden="true"
      title={`Drag to move the ${dates.due ? 'deadline' : 'start'} of ${title}`}
      className={`${handle} w-4 -translate-x-1/2 cursor-ew-resize rounded hover:bg-slate-900/10`}
      style={{ left: `${left}%` }}
      {...handlers('move')}
      data-schedule-part="move"
    />
  )
}
