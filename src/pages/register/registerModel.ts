import type { Clause } from '../../data/useClauses.ts'
import type { ClauseState, ClauseStatus } from '../../data/useClauseStatus.ts'

// One rule, joined to what the team did about it this season.
//
// `clause_key` is identity. `printed_ref` is what the book prints, and the book
// prints some references twice (E.5.4.5 and F.5.2.3 each appear on two
// different clauses). That is an error in the Organization's PDF, not in the
// import — never merge or renumber them. Everything here keys on clause_key so
// the two stay independently addressable.
export type RegisterRow = {
  clause: Clause
  status: ClauseStatus | null
  // No clause_status row means untouched, and the column's default is 'open'.
  state: ClauseState
  ownerId: string | null
  starred: boolean
  evidence: string | null
  isParked: boolean
}

export type SubteamInfo = { name: string; isParked: boolean }

export function buildRows(
  clauses: Clause[],
  statuses: ClauseStatus[],
  subteams: Map<string, SubteamInfo>,
): RegisterRow[] {
  const byClause = new Map(statuses.map((s) => [s.clause_key, s]))
  return clauses.map((clause) => {
    const status = byClause.get(clause.clause_key) ?? null
    return {
      clause,
      status,
      state: status?.state ?? 'open',
      ownerId: status?.owner_id ?? null,
      starred: status?.starred ?? false,
      evidence: status?.evidence ?? null,
      isParked: clause.subteam_key
        ? (subteams.get(clause.subteam_key)?.isParked ?? false)
        : false,
    }
  })
}

// --- Filters ----------------------------------------------------------------

export type Filters = {
  search: string
  // ON by default. 1,146 rules exist but only 491 place a duty on the team;
  // the rest are definitions and the Organization's own powers. This toggle is
  // the difference between usable and not, so it is a visible control — never
  // a hidden default.
  teamDutiesOnly: boolean
  obligation: string
  owner: string
  unresolvedOnly: boolean
}

export const DEFAULT_FILTERS: Filters = {
  search: '',
  teamDutiesOnly: true,
  obligation: 'all',
  owner: 'all',
  unresolvedOnly: false,
}

const RESOLVED: ReadonlySet<ClauseState> = new Set<ClauseState>([
  'compliant',
  'verified',
  'na',
])

export function isResolved(state: ClauseState): boolean {
  return RESOLVED.has(state)
}

export function applyFilters(rows: RegisterRow[], filters: Filters): RegisterRow[] {
  const needle = filters.search.trim().toLowerCase()

  return rows.filter((row) => {
    if (filters.teamDutiesOnly && !row.clause.is_team_duty) return false
    if (filters.obligation !== 'all' && row.clause.obligation !== filters.obligation) {
      return false
    }
    if (filters.owner === 'unassigned' && row.ownerId !== null) return false
    if (filters.owner !== 'all' && filters.owner !== 'unassigned' && row.ownerId !== filters.owner) {
      return false
    }
    if (filters.unresolvedOnly && isResolved(row.state)) return false

    if (needle) {
      const haystack = [
        row.clause.printed_ref,
        row.clause.clause_key,
        row.clause.body,
        row.clause.article_title ?? '',
        row.clause.group_title ?? '',
      ]
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

// --- Groupings --------------------------------------------------------------
// The point of the screen. 1,146 rules as one list is unusable; the same rules
// re-filed by the question you are actually asking is not.

export type GroupingId =
  | 'subsystem'
  | 'kind'
  | 'milestone'
  | 'owner'
  | 'status'
  | 'book'

export const GROUPINGS: { id: GroupingId; label: string; hint: string }[] = [
  { id: 'subsystem', label: 'Subsystem', hint: 'Maps to a person' },
  { id: 'kind', label: 'Kind of work', hint: 'What type of thing to do' },
  { id: 'milestone', label: 'Milestone', hint: 'What it blocks' },
  { id: 'owner', label: 'Owner', hint: 'Most useful before a meeting' },
  { id: 'status', label: 'Status', hint: 'Where things stand' },
  { id: 'book', label: 'Book order', hint: 'When someone quotes a number' },
]

export type Group = { key: string; label: string; rows: RegisterRow[] }

export type GroupContext = {
  subteams: Map<string, SubteamInfo>
  memberNames: Map<string, string>
}

const STATE_LABEL: Record<ClauseState, string> = {
  open: 'Open',
  wip: 'In progress',
  compliant: 'Compliant',
  verified: 'Verified',
  blocked: 'Blocked',
  na: 'Not applicable',
}

function bucketOf(
  row: RegisterRow,
  grouping: GroupingId,
  ctx: GroupContext,
): { key: string; label: string; sort: string } {
  switch (grouping) {
    case 'subsystem': {
      const key = row.clause.subteam_key ?? '(none)'
      return {
        key,
        label: ctx.subteams.get(key)?.name ?? key,
        sort: ctx.subteams.get(key)?.name ?? 'zzz',
      }
    }
    case 'kind':
      return { key: row.clause.obligation, label: row.clause.obligation, sort: row.clause.obligation }
    case 'milestone': {
      const key = row.clause.milestone_key ?? '(none)'
      return {
        key,
        // A real bucket, not a gap: most rules are not tied to a milestone.
        label: row.clause.milestone_key ?? 'Not tied to a milestone',
        sort: row.clause.milestone_key ?? 'zzz',
      }
    }
    case 'owner': {
      if (!row.ownerId) return { key: 'unassigned', label: 'Unassigned', sort: '' }
      return {
        key: row.ownerId,
        label: ctx.memberNames.get(row.ownerId) ?? 'Unknown member',
        sort: ctx.memberNames.get(row.ownerId) ?? 'zzz',
      }
    }
    case 'status':
      return { key: row.state, label: STATE_LABEL[row.state], sort: row.state }
    case 'book':
      return {
        key: `${row.clause.section}.${row.clause.article}`,
        label: `Section ${row.clause.section} — Art. ${row.clause.article}${
          row.clause.article_title ? `: ${row.clause.article_title}` : ''
        }`,
        sort: `${row.clause.section}.${String(row.clause.article).padStart(4, '0')}`,
      }
  }
}

export function groupRows(
  rows: RegisterRow[],
  grouping: GroupingId,
  ctx: GroupContext,
): Group[] {
  const buckets = new Map<string, Group & { sort: string }>()

  for (const row of rows) {
    const bucket = bucketOf(row, grouping, ctx)
    const existing = buckets.get(bucket.key)
    if (existing) existing.rows.push(row)
    else buckets.set(bucket.key, { key: bucket.key, label: bucket.label, sort: bucket.sort, rows: [row] })
  }

  return [...buckets.values()]
    .sort((a, b) => a.sort.localeCompare(b.sort))
    .map(({ key, label, rows: groupRowList }) => ({ key, label, rows: groupRowList }))
}

// --- Presentation helpers ---------------------------------------------------

// criticality = 'blocking' means non-compliance scores NC. 'penalty' means
// MP/SP/NP risk. Both must read at a glance.
export function criticalityBadge(
  criticality: string,
): { label: string; title: string; className: string } | null {
  if (criticality === 'blocking') {
    return {
      label: 'NC RISK',
      title: 'Non-compliance scores NC — the bike does not run',
      className: 'bg-red-700 text-white',
    }
  }
  if (criticality === 'penalty') {
    return {
      label: 'PENALTY',
      title: 'Non-compliance risks MP / SP / NP penalty points',
      className: 'bg-amber-500 text-amber-950',
    }
  }
  return null
}

type SpecEntry = { op?: string; unit?: string; value?: number }

// Numeric limits the parser extracted from the rule text, e.g. min 450 mm.
export function readSpecs(specs: Clause['specs']): SpecEntry[] {
  if (!Array.isArray(specs)) return []
  return specs.filter(
    (entry): entry is SpecEntry => typeof entry === 'object' && entry !== null,
  )
}

export function formatSpec(spec: SpecEntry): string {
  const op = spec.op === 'min' ? '≥' : spec.op === 'max' ? '≤' : '='
  return `${op} ${spec.value ?? '?'}${spec.unit ? ` ${spec.unit}` : ''}`
}
