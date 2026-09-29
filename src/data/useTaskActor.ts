import { useMemo } from 'react'
import { useAuth } from '../auth/context.ts'
import type { TaskActor } from '../auth/permissions.ts'
import { useMembers } from './useMembers.ts'
import { useSubteams } from './useSubteams.ts'

// The signed-in member as the department-authority actor: their roster status,
// whether they hold the Developer role, which active departments they head
// (directly, or as the Head of the parent department), and — for an active
// President or Vice President — which departments have no Head at all, where
// they act instead (department_authority(), 20260126000200). Built here, in
// the data layer, because it comes from the departments and roster queries and
// permissions.ts owns no fetching. Null until a member is signed in. Used only
// to decide what to SHOW; the database re-checks everything on every request.
export function useTaskActor(): TaskActor | null {
  const auth = useAuth()
  const departments = useSubteams()
  const members = useMembers()
  const memberId = auth.status === 'member' ? auth.member.id : null
  const status = auth.status === 'member' ? auth.member.status : null
  const roles = auth.status === 'member' ? (auth.roles ?? []) : []
  const isDeveloper = roles.includes('developer')
  const isGovernance = roles.includes('president') || roles.includes('vicepresident')

  return useMemo(() => {
    if (memberId === null || status === null) return null
    const all = departments.data ?? []
    const byKey = new Map(all.map((d) => [d.key, d]))
    const active = all.filter((d) => d.archived_at === null)
    const activeMemberIds = new Set((members.data ?? []).filter((member) => member.status === 'active').map((member) => member.id))
    const parentOf = (d: (typeof all)[number]) => (d.parent_key === null ? undefined : byKey.get(d.parent_key))
    const headOf = active
      .filter((d) => {
        if (d.lead_id === memberId) return true
        const parent = parentOf(d)
        return parent !== undefined && parent.archived_at === null && parent.lead_id === memberId
      })
      .map((d) => d.key)
    const governs = isGovernance
      ? active
          .filter((d) => {
            const parent = parentOf(d)
            const directlyHeaded = d.lead_id !== null && activeMemberIds.has(d.lead_id)
            const parentHeaded = parent !== undefined && parent.archived_at === null
              && parent.lead_id !== null && activeMemberIds.has(parent.lead_id)
            return !directlyHeaded && !parentHeaded
          })
          .map((d) => d.key)
      : []
    return { id: memberId, status, isDeveloper, headOf, isGovernance, governs }
  }, [memberId, status, isDeveloper, isGovernance, departments.data, members.data])
}
