import { useId } from 'react'
import { ALL_DEPARTMENTS, type DepartmentChoice } from './filter.ts'

const SELECT =
  'mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'

// The one Scope x Department control. Scope is a pressed-state button group
// (a filter, not a navigation); Department is a native select, which is the
// compact selector on a phone and works with any keyboard or screen reader. Both
// are independent: nothing here knows about a "tab per combination".
export function ScopeDepartmentFilter<S extends string>({
  scopes,
  scope,
  onScope,
  counts,
  scopeGroupLabel,
  scopeTestId,
  departments,
  department,
  onDepartment,
}: {
  scopes: { value: S; label: string }[]
  scope: S
  onScope: (scope: S) => void
  counts: Record<S, number>
  scopeGroupLabel: string
  scopeTestId: string
  // Omitted where the screen shows the department as its own navigation row
  // (DepartmentNav) — then this is the scope filter alone.
  departments?: DepartmentChoice[]
  department?: string
  onDepartment?: (department: string) => void
}) {
  const deptId = useId()
  const button = (active: boolean) =>
    `min-h-11 rounded px-3 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0 ${
      active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
    }`

  return (
    <div className={departments ? 'grid gap-2 sm:grid-cols-[auto_minmax(12rem,1fr)] sm:items-end sm:gap-4' : 'flex flex-wrap items-end gap-2'}>
      <div role="group" aria-label={scopeGroupLabel} data-testid={scopeTestId} className="flex flex-wrap gap-1 rounded-md bg-slate-50 p-1">
        {scopes.map((option) => (
          <button key={option.value} type="button" aria-pressed={scope === option.value} onClick={() => onScope(option.value)} className={button(scope === option.value)}>
            {option.label} <span className="font-normal opacity-80">({counts[option.value]})</span>
          </button>
        ))}
      </div>
      {departments && (
        <div>
          <label htmlFor={deptId} className="block text-xs font-medium text-slate-600">
            Department
          </label>
          <select id={deptId} value={department} onChange={(e) => onDepartment?.(e.target.value)} className={SELECT}>
            <option value={ALL_DEPARTMENTS}>All departments</option>
            {departments.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
