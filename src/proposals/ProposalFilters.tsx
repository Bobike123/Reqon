import { ScopeDepartmentFilter } from '../departments/ScopeDepartmentFilter.tsx'
import {
  DEFAULT_FILTER,
  describeFilter,
  isDefaultFilter,
  type ProposalFilter,
  type ProposalScope,
  type ProposalView,
} from './filters.ts'

const SCOPES: { value: ProposalScope; label: string }[] = [
  { value: 'all', label: 'All proposals' },
  { value: 'mine', label: 'My proposals' },
]

// The shared Scope x Department filter, plus (on the Proposals screen) the switch
// between the open queue and History. On a phone the department is a full-width
// select and the buttons wrap; nothing depends on hover. The current filter is
// always written out in words, and cleared with one button.
export function ProposalFilters({
  filter,
  onChange,
  counts,
  departments,
  showViews,
  viewCounts,
  shown,
  showDepartment = true,
}: {
  filter: ProposalFilter
  onChange: (next: ProposalFilter) => void
  counts: Record<ProposalScope, number>
  departments: { key: string; label: string }[]
  showViews: boolean
  viewCounts?: Record<ProposalView, number>
  shown: number
  // False where the screen shows the department as its own navigation row.
  showDepartment?: boolean
}) {
  const departmentLabel = departments.find((d) => d.key === filter.department)?.label ?? null
  const set = (patch: Partial<ProposalFilter>) => onChange({ ...filter, ...patch })

  const button = (active: boolean) =>
    `min-h-11 rounded px-3 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0 ${
      active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
    }`

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid="proposal-filters">
      {showViews && (
        <div role="group" aria-label="Which proposals" className="mb-2 flex flex-wrap gap-1 rounded-md bg-slate-50 p-1" data-testid="proposal-views">
          {(['queue', 'history'] as const).map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={filter.view === view}
              onClick={() => set({ view })}
              className={button(filter.view === view)}
            >
              {view === 'queue' ? 'Open queue' : 'History'}
              {viewCounts && <span className="ml-1 font-normal opacity-80">({viewCounts[view]})</span>}
            </button>
          ))}
        </div>
      )}

      <ScopeDepartmentFilter
        scopes={SCOPES}
        scope={filter.scope}
        onScope={(scope) => set({ scope })}
        counts={counts}
        scopeGroupLabel="Whose proposals"
        scopeTestId="proposal-scope"
        {...(showDepartment
          ? { departments, department: filter.department, onDepartment: (department: string) => set({ department }) }
          : {})}
      />

      <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600" data-testid="proposal-filter-summary">
        <span>
          Showing {shown} · {describeFilter(filter, departmentLabel)}
          {filter.view === 'history' ? ' · History' : ''}
        </span>
        {!isDefaultFilter(filter) && (
          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_FILTER, view: filter.view })}
            className="inline-flex min-h-11 items-center rounded font-medium text-slate-900 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          >
            Clear filters
          </button>
        )}
      </p>
    </div>
  )
}
