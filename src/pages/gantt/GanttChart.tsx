import type { ReactNode } from 'react'
import { placeBar, type Span } from './ganttModel.ts'

// Shared chart primitives (Phase 6 §6.3): the label-column/timeline grid, the
// track a bar draws in, and the bar itself. Used by MilestoneRow, SectionRow
// and GanttTaskRow so all three levels — and the month/week ruler in
// Gantt.tsx — share exactly one left edge and one bar-drawing rule.

// Label column, then the timeline. One constant so all three levels and the
// month ruler share a single left edge — the thing that makes a Gantt readable.
export const ROW = 'grid grid-cols-[minmax(15rem,22rem)_1fr] items-start gap-3'

// The label column stays visible while the timeline scrolls under it — the
// whole point of the weekly scale is a chart wider than the screen.
export const STICKY_LABEL = 'sticky left-0 z-10 self-stretch'

export const selectSmall =
  'min-h-11 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'

// The track every bar is drawn in, with the "today" line on top of it. The line
// is repeated per row rather than laid over the whole chart: it then cannot
// drift out of alignment when a row changes height.
export function Track({
  today,
  children,
  label,
}: {
  today: number | null
  label?: string
  children?: ReactNode
}) {
  return (
    <div className="relative h-7 rounded bg-slate-50 ring-1 ring-inset ring-slate-200">
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
export function Bar({
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
