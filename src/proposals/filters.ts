import { ALL_DEPARTMENTS, departmentChoices as choicesFor } from '../departments/filter.ts'
import type { Proposal } from './types.ts'

export { ALL_DEPARTMENTS }

// The proposal list's two-dimensional filter (Scope x Department) plus which
// list you are looking at. Pure and dependency-free so the panel, the tests and
// any future screen share one definition (execution contract: one All/My
// convention, one department selector).
export type ProposalScope = 'all' | 'mine'
export type ProposalView = 'queue' | 'history'

export type ProposalFilter = {
  scope: ProposalScope
  // A department key, or ALL_DEPARTMENTS.
  department: string
  view: ProposalView
}

export const DEFAULT_FILTER: ProposalFilter = { scope: 'all', department: ALL_DEPARTMENTS, view: 'queue' }

// History is everything that has been decided or archived: approved (promoted),
// rejected, and older decided proposals whose outcome was never recorded. The
// queue is the live work: suggested, under review, and PARKED. A parked
// proposal stays in the queue, marked, so it is never lost from sight.
export function isHistory(proposal: Pick<Proposal, 'state' | 'archived_at'>): boolean {
  return proposal.archived_at !== null || proposal.state === 'decided'
}

// "My proposals" means authored by the viewer (raised_by), never the proposed
// owner.
export function filterProposals(
  proposals: readonly Proposal[],
  filter: ProposalFilter,
  viewerId: string | null,
): Proposal[] {
  return proposals.filter((p) => {
    if ((filter.view === 'history') !== isHistory(p)) return false
    if (filter.scope === 'mine' && (viewerId === null || p.raised_by !== viewerId)) return false
    if (filter.department !== ALL_DEPARTMENTS && p.subteam_key !== filter.department) return false
    return true
  })
}

// The numbers on the Scope buttons: what each would show under the current
// department and view.
export function scopeCounts(
  proposals: readonly Proposal[],
  filter: ProposalFilter,
  viewerId: string | null,
): Record<ProposalScope, number> {
  return {
    all: filterProposals(proposals, { ...filter, scope: 'all' }, viewerId).length,
    mine: filterProposals(proposals, { ...filter, scope: 'mine' }, viewerId).length,
  }
}

type Dept = { key: string; name: string; archived_at: string | null }

// The department choices for a view. The queue offers only ACTIVE departments
// (at most ten); History also lists archived ones that proposals still belong to,
// marked as archived, so old work stays reachable.
export function departmentChoices(
  departments: readonly Dept[],
  proposals: readonly Pick<Proposal, 'subteam_key'>[],
  view: ProposalView,
): { key: string; label: string }[] {
  const used = view === 'history' ? new Set(proposals.map((p) => p.subteam_key).filter((k): k is string => k !== null)) : new Set<string>()
  return choicesFor(departments, used)
}

export function describeFilter(filter: ProposalFilter, departmentLabel: string | null): string {
  const scope = filter.scope === 'mine' ? 'My proposals' : 'All proposals'
  const dept = filter.department === ALL_DEPARTMENTS ? 'All departments' : (departmentLabel ?? filter.department)
  return `${scope} · ${dept}`
}

export function isDefaultFilter(filter: ProposalFilter): boolean {
  return filter.scope === 'all' && filter.department === ALL_DEPARTMENTS
}
