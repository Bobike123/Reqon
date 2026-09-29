// The department half of every Scope x Department filter (proposals, Board,
// archive): one value convention and one way to read it from a URL. Pure.
export const ALL_DEPARTMENTS = 'all'

type Dept = { key: string; name: string; archived_at: string | null }
export type DepartmentChoice = { key: string; label: string }

// Active departments, plus any archived one that `alsoInclude` names (the one
// currently selected, or ones history still refers to), marked as archived so
// old work and a bookmarked filter stay resolvable.
export function departmentChoices(departments: readonly Dept[], alsoInclude: ReadonlySet<string> = new Set()): DepartmentChoice[] {
  return departments
    .filter((d) => d.archived_at === null || alsoInclude.has(d.key))
    .map((d) => ({ key: d.key, label: d.archived_at === null ? d.name : `${d.name} (archived)` }))
}

// A department value from an address (?dept=...). Anything that is not a known
// department is NOT silently honoured or silently dropped: it falls back to "all
// departments" and says so.
export function resolveDepartmentParam(
  value: string | null,
  departments: readonly Dept[],
): { department: string; notice: string | null } {
  if (!value || value === ALL_DEPARTMENTS) return { department: ALL_DEPARTMENTS, notice: null }
  if (departments.some((d) => d.key === value)) return { department: value, notice: null }
  return { department: ALL_DEPARTMENTS, notice: `There is no department “${value}”, so all departments are shown.` }
}
