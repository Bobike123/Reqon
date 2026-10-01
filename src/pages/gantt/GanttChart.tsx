import type { ReactNode } from 'react'
import { placeBar, placeDay, type Span } from './ganttModel.ts'

// Shared chart primitives: the label-column/timeline grid, the track shapes are
// drawn in, and the shapes themselves. Used by every row level and by the ruler
// in Gantt.tsx, so all of them share one left edge and one drawing rule.
//
// One shape per meaning, so nothing depends on colour alone (the legend in
// GanttLegend.tsx explains each):
//   dashed line + "Today" on the ruler   today
//   solid wide bar                       a submission's window
//   diamond ◆                            a submission's hard deadline
//   outlined bar                         a task's period (starts → due)
//   dot ●                                a task's deadline (no start recorded)
//   triangle ▸                           a task start (no deadline recorded)
//   "!" inside the mark, red             overdue open work
//   "✓" inside the mark, muted           completed work
// Every mark is decorative to assistive technology (aria-hidden); the same fact
// is written out as text in the row's summary (`summary` on Track). Marks may
// carry a short date caption ("20 Nov → 25 Nov", "Due 27 Nov") drawn beside
// them, so periods and deadlines read without hovering.

export const ROW = 'grid grid-cols-[minmax(15rem,22rem)_1fr] items-start gap-3'

// The label column stays visible while the timeline scrolls under it — the whole
// point of the weekly scale is a chart wider than the screen.
export const STICKY_LABEL = 'sticky left-0 z-10 self-stretch'

// A mark's date caption: after the mark, or before it when the mark sits near
// the right edge so the text stays inside the track.
function Caption({ from, to, text }: { from: number; to: number; text: string }) {
  const style = to <= 75 ? { left: `calc(${to}% + 6px)` } : { right: `calc(${100 - from}% + 6px)` }
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 z-[1] -translate-y-1/2 whitespace-nowrap rounded bg-white/80 px-0.5 text-[10px] leading-4 text-slate-700"
      style={style}
    >
      {text}
    </span>
  )
}

export const selectSmall =
  'min-h-11 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'

// The track every mark is drawn in, with the "today" line on top of it. The line
// is repeated per row rather than laid over the whole chart, so it cannot drift
// out of alignment when a row changes height. `summary` is the row's facts in
// words, read by assistive technology.
export function Track({
  today,
  children,
  label,
  summary,
}: {
  today: number | null
  label?: string
  summary?: string
  children?: ReactNode
}) {
  return (
    <div className="relative h-7 rounded bg-slate-50 ring-1 ring-inset ring-slate-200">
      {today !== null && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 border-l-2 border-dashed border-red-600"
          style={{ left: `${today}%` }}
        />
      )}
      {label && (
        <span className="absolute inset-y-0 left-1 flex items-center text-[11px] text-slate-600">{label}</span>
      )}
      {children}
      {summary && <span className="sr-only">{summary}</span>}
    </div>
  )
}

// A bar with progress filled in from the left. Two styles: a solid bar (a
// submission's window) and an outlined bar (a task's period), which read as
// different things even in greyscale. `glyph` is drawn inside.
export function Bar({
  span,
  range,
  percent,
  tone,
  title,
  variant = 'solid',
  glyph,
  caption,
}: {
  span: Span
  range: Span
  percent?: number
  tone: string
  title: string
  variant?: 'solid' | 'outline'
  // "!" for overdue, "✓" for done — a second cue beside colour.
  glyph?: string
  caption?: string
}) {
  const box = placeBar(span, range)
  if (!box) return null
  return (
    <>
      <span
        title={title}
        className={`absolute inset-y-1 min-w-[3px] overflow-hidden rounded ${
          variant === 'outline' ? 'border-2 bg-white/70' : ''
        } ${tone}`}
        style={{ left: `${box.left}%`, width: `${box.width}%` }}
      >
        {percent !== undefined && percent > 0 && (
          <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-slate-900/35" style={{ width: `${percent}%` }} />
        )}
        {glyph && (
          <span aria-hidden="true" className="relative z-[1] px-0.5 text-[11px] font-bold leading-5">
            {glyph}
          </span>
        )}
      </span>
      {caption && <Caption from={box.left} to={box.left + box.width} text={caption} />}
    </>
  )
}

export type MarkerKind = 'milestone-deadline' | 'task-deadline' | 'task-start'

const MARKER_GLYPH: Record<MarkerKind, string> = {
  'milestone-deadline': '◆',
  'task-deadline': '●',
  'task-start': '▸',
}

// A single-day mark: the hard deadline of a submission, or a task with only one
// date. `overdue` and `done` swap in "!" and "✓" and change the tone, so the
// state reads from the symbol, not only from red or grey.
export function Marker({
  day,
  range,
  kind,
  title,
  overdue,
  done,
  caption,
}: {
  day: string
  range: Span
  kind: MarkerKind
  title: string
  overdue?: boolean
  done?: boolean
  caption?: string
}) {
  const left = placeDay(day, range)
  if (left === null) return null
  const glyph = done ? '✓' : overdue ? '!' : MARKER_GLYPH[kind]
  const tone = done ? 'text-slate-500' : overdue ? 'text-red-700' : kind === 'milestone-deadline' ? 'text-slate-900' : 'text-slate-700'
  return (
    <>
      <span
        aria-hidden="true"
        title={title}
        className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-base font-bold leading-none ${tone}`}
        style={{ left: `${left}%` }}
      >
        {glyph}
      </span>
      {caption && <Caption from={left} to={left} text={caption} />}
    </>
  )
}
