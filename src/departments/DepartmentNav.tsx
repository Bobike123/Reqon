import { useId } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { mergeSearchParams } from '../lib/searchParams.ts'
import { ALL_DEPARTMENTS, type DepartmentChoice } from './filter.ts'

// The one department navigation row, directly under a screen's title on the
// Board, Proposals and the Gantt. It is NAVIGATION: each department is its own
// address (a link, marked aria-current), so it can be bookmarked, opened in a
// new tab and shared. That keeps it visibly different from the All/My scope,
// which is a FILTER (pressed-state buttons), and from disclosures (aria-expanded).
//
// Departments come from the configured list in its configured order, so a new
// one appears here on its own. Long names are clipped with the full name kept
// as the accessible name and tooltip; the row wraps instead of widening the
// page. On a phone the row becomes one labelled select.
export function DepartmentNav({
  choices,
  value,
  param = 'dept',
  counts,
  label = 'Department',
  testId,
}: {
  choices: DepartmentChoice[]
  value: string
  // The address parameter holding the department. Every OTHER parameter in the
  // current address is kept when the department changes (?task=, open groups…).
  param?: string
  // Optional number shown beside each entry (keyed by department key and 'all').
  counts?: Readonly<Record<string, number>>
  label?: string
  testId: string
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const selectId = useId()
  const hrefFor = (key: string) => {
    const next = mergeSearchParams(new URLSearchParams(location.search), {
      [param]: key === ALL_DEPARTMENTS ? null : key,
    })
    const search = next.toString()
    return { pathname: location.pathname, search: search ? `?${search}` : '' }
  }
  const entries = [{ key: ALL_DEPARTMENTS, label: 'All departments' }, ...choices]
  const count = (key: string) => (counts && counts[key] !== undefined ? counts[key] : null)

  return (
    <div className="mb-3" data-testid={testId}>
      <nav aria-label={`${label} navigation`} className="hidden sm:block">
        <ul className="flex flex-wrap gap-1.5">
          {entries.map((entry) => {
            const active = entry.key === value
            const n = count(entry.key)
            return (
              <li key={entry.key} className="min-w-0">
                <Link
                  to={hrefFor(entry.key)}
                  replace
                  aria-current={active ? 'page' : undefined}
                  title={entry.label}
                  className={`inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-1 ${
                    active
                      ? 'border-slate-900 bg-slate-900 font-medium text-white'
                      : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50'
                  }`}
                >
                  <span className="truncate">{entry.label}</span>
                  {n !== null && (
                    <span className={`shrink-0 tabular-nums text-xs ${active ? 'text-slate-200' : 'text-slate-500'}`}>
                      {n}
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="sm:hidden">
        <label htmlFor={selectId} className="block text-xs font-medium text-slate-600">
          {label}
        </label>
        <select
          id={selectId}
          value={value}
          onChange={(e) => navigate(hrefFor(e.target.value), { replace: true })}
          className="mt-1 min-h-11 w-full max-w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
        >
          {entries.map((entry) => {
            const n = count(entry.key)
            return (
              <option key={entry.key} value={entry.key}>
                {entry.label}
                {n !== null ? ` (${n})` : ''}
              </option>
            )
          })}
        </select>
      </div>
    </div>
  )
}
