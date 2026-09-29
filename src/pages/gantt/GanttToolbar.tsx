import { buttonSecondary } from '../../ui/buttons.ts'
import { selectSmall } from './GanttChart.tsx'

// Expand/collapse everything, and the month/week scale. Pure interaction
// orchestration handed up to Gantt.tsx as callbacks (Phase 6 §6.3) — this
// component holds no state of its own.
export function GanttToolbar({
  allOpen,
  onToggleAll,
  scale,
  onScale,
  legendOpen,
  legendId,
  onLegend,
}: {
  allOpen: boolean
  onToggleAll: () => void
  scale: 'month' | 'week'
  onScale: (scale: 'month' | 'week') => void
  legendOpen: boolean
  legendId: string
  onLegend: () => void
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <button type="button" className={`${buttonSecondary} text-xs`} onClick={onToggleAll}>
        {allOpen ? 'Collapse all' : 'Expand all'}
      </button>
      <label className="flex items-center gap-1.5 text-xs text-slate-600">
        Scale
        <select
          value={scale}
          onChange={(e) => onScale(e.target.value as 'month' | 'week')}
          className={selectSmall}
        >
          <option value="month">Monthly</option>
          <option value="week">Weekly</option>
        </select>
      </label>
      <button
        type="button"
        className={`${buttonSecondary} text-xs`}
        aria-expanded={legendOpen}
        aria-controls={legendId}
        onClick={onLegend}
        data-testid="gantt-legend-toggle"
      >
        Legend
      </button>
      <p className="text-xs text-slate-600">
        The dashed line is today. A submission’s bar fills from the left as its linked tasks are done. Drag a task’s
        bar to change its dates, or its row onto another section — or open the row to do the same with the keyboard.
      </p>
    </div>
  )
}
