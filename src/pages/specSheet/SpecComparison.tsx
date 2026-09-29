import type { PresentableSpec, StatusPresentation } from '../../specs/presentation.ts'
import {
  DIRECTION_LABELS,
  thresholdItems,
  projectStatus,
  regulatoryStatus,
  zoneStatus,
} from '../../specs/presentation.ts'

const TONE: Record<StatusPresentation['tone'], string> = {
  red: 'border-red-300 bg-red-50 text-red-900',
  amber: 'border-amber-300 bg-amber-50 text-amber-950',
  green: 'border-emerald-300 bg-emerald-50 text-emerald-950',
  grey: 'border-slate-300 bg-slate-50 text-slate-700',
}

function StatusChip({ status, testId }: { status: StatusPresentation; testId: string }) {
  return (
    <span
      className={`inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[status.tone]}`}
      data-testid={testId}
    >
      <span aria-hidden="true" className="inline-flex size-4 items-center justify-center font-bold">
        {status.icon}
      </span>
      {status.label}
    </span>
  )
}

export function SpecStatuses({ spec }: { spec: PresentableSpec }) {
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Specification statuses">
      <StatusChip status={zoneStatus(spec.zone)} testId={`zone-${spec.id}`} />
      <StatusChip status={regulatoryStatus(spec.verdict)} testId={`regulatory-status-${spec.id}`} />
      <StatusChip status={projectStatus(spec.goal_status)} testId={`goal-status-${spec.id}`} />
    </div>
  )
}

// The thresholds the compact row does not show — the direction and, where the
// direction has them, the minimum/maximum acceptable value and the project
// goal — for the expanded row.
export function SpecThresholds({ spec }: { spec: PresentableSpec }) {
  return (
    <div>
      <p className="mb-1 text-xs text-slate-500" data-testid={`direction-${spec.id}`}>
        {DIRECTION_LABELS[spec.direction ?? ''] ?? 'Direction unknown'}
      </p>
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-2" data-testid={`thresholds-${spec.id}`}>
        {thresholdItems(spec).map((item) => (
          <div key={item.key} className="min-w-0 bg-white px-2.5 py-2">
            <dt className="text-[0.68rem] font-medium tracking-wide text-slate-500 uppercase">{item.label}</dt>
            <dd
              className={`mt-0.5 break-words font-mono text-sm ${item.missing ? 'text-slate-500' : 'font-semibold text-slate-900'}`}
              data-testid={`comparison-${item.key}-${spec.id}`}
            >
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
