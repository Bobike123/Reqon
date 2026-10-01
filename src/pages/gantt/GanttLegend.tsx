import type { ReactNode } from 'react'

// What every shape on the timeline means. Always visible and compact, and each
// entry pairs the SHAPE with words, so the chart never relies on colour alone.
// The samples are decorative (aria-hidden): the list itself carries the meaning.
const ENTRIES: { sample: ReactNode; text: string }[] = [
  {
    sample: <span className="inline-block h-4 w-0 border-l-2 border-dashed border-red-600" />,
    text: 'Today (dashed line)',
  },
  {
    sample: <span className="inline-block h-3 w-8 rounded bg-slate-700" />,
    text: 'Submission window (solid bar, filled as work is done)',
  },
  { sample: <span className="text-base font-bold leading-none text-slate-900">◆</span>, text: 'Submission deadline' },
  {
    sample: <span className="inline-block h-3 w-8 rounded border-2 border-slate-500 bg-white/70" />,
    text: 'Task period (start to deadline)',
  },
  { sample: <span className="text-base font-bold leading-none text-slate-700">●</span>, text: 'Task deadline, no start date' },
  { sample: <span className="text-base font-bold leading-none text-slate-700">▸</span>, text: 'Task start, no deadline' },
  { sample: <span className="text-base font-bold leading-none text-red-700">!</span>, text: 'Overdue, still open' },
  { sample: <span className="text-base font-bold leading-none text-slate-500">✓</span>, text: 'Done' },
]

export function GanttLegend({ id }: { id?: string }) {
  return (
    <section id={id} aria-label="Legend" className="mb-3 rounded-lg border border-slate-200 bg-white px-3 py-2" data-testid="gantt-legend">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
        {ENTRIES.map((entry) => (
          <li key={entry.text} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-flex min-w-8 items-center justify-center">
              {entry.sample}
            </span>
            {entry.text}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-slate-600">
        A task with no dates draws nothing and says so. A submission with no opening date shows only its deadline;
        one with no dates at all draws nothing. Nothing is estimated.
      </p>
    </section>
  )
}
