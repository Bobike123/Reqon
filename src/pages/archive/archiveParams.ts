import { ARCHIVE_PAGE_SIZE, type ArchivedTaskQuery, type ProposalHistoryQuery } from '../../data/useTaskHistory.ts'
import { TASK_STATES } from '../../tasks/taskState.ts'

// The Archive's state lives in the address (?tab=&dept=&owner=&state=&q=&page=&id=)
// so a filtered history can be bookmarked, shared and reloaded. Every value is
// validated: an unknown tab, state or page number falls back to a safe default
// and is reported, never trusted or silently reinterpreted.
export type ArchiveTab = 'tasks' | 'proposals'
export const PROPOSAL_STATUSES = ['approved', 'rejected', 'other'] as const

export type ArchiveParams = {
  tab: ArchiveTab
  department: string
  owner: string
  state: string
  search: string
  id: string
  page: number
}

export function parseArchiveParams(params: URLSearchParams): { value: ArchiveParams; notice: string | null } {
  const notices: string[] = []
  const rawTab = params.get('tab')
  const tab: ArchiveTab = rawTab === 'proposals' ? 'proposals' : 'tasks'
  if (rawTab && rawTab !== 'tasks' && rawTab !== 'proposals') notices.push(`“${rawTab}” is not part of the Archive, so tasks are shown.`)

  const rawState = params.get('state') ?? ''
  const validStates: readonly string[] = tab === 'tasks' ? TASK_STATES.map((s) => s.state) : PROPOSAL_STATUSES
  let state = rawState
  if (rawState && !validStates.includes(rawState)) {
    state = ''
    notices.push(`“${rawState}” is not a status here, so every status is shown.`)
  }

  const rawPage = params.get('page')
  const parsed = rawPage === null ? 0 : Number(rawPage) - 1
  const page = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
  if (rawPage !== null && page === 0 && rawPage !== '1') notices.push('That page number is not valid, so the first page is shown.')

  return {
    value: {
      tab,
      department: params.get('dept') ?? '',
      owner: params.get('owner') ?? '',
      state,
      search: params.get('q') ?? '',
      id: params.get('id') ?? '',
      page,
    },
    notice: notices[0] ?? null,
  }
}

// Only non-default values are written. Changing any filter returns to page 1.
export function archiveParamsToSearch(value: ArchiveParams): URLSearchParams {
  const p = new URLSearchParams()
  if (value.tab !== 'tasks') p.set('tab', value.tab)
  if (value.department) p.set('dept', value.department)
  if (value.owner) p.set('owner', value.owner)
  if (value.state) p.set('state', value.state)
  if (value.search.trim()) p.set('q', value.search.trim())
  if (value.id) p.set('id', value.id)
  if (value.page > 0) p.set('page', String(value.page + 1))
  return p
}

export function toTaskQuery(v: ArchiveParams): ArchivedTaskQuery {
  return { department: v.department, owner: v.owner, state: v.state, search: v.search, id: v.id, page: v.page }
}

export function toProposalQuery(v: ArchiveParams): ProposalHistoryQuery {
  return {
    department: v.department,
    owner: v.owner,
    status: (PROPOSAL_STATUSES as readonly string[]).includes(v.state) ? (v.state as ProposalHistoryQuery['status']) : '',
    search: v.search,
    id: v.id,
    page: v.page,
  }
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE))
}

export function hasActiveFilters(v: ArchiveParams): boolean {
  return Boolean(v.department || v.owner || v.state || v.search.trim() || v.id)
}
