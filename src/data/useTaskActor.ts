import { useMemo } from 'react'
import { useAuth } from '../auth/context.ts'
import type { TaskActor } from '../auth/permissions.ts'
import { useSubteams } from './useSubteams.ts'

// The signed-in member as ADR-0003's actor: their roster status, whether they
// hold the Developer role, and which active departments they head. Built here,
// in the data layer, because "which departments do they head" comes from the
// departments query and permissions.ts owns no fetching. Null until a member
// is signed in. Used only to decide what to SHOW; the database re-checks
// everything on every request.
export function useTaskActor(): TaskActor | null {
  const auth = useAuth()
  const departments = useSubteams()
  const memberId = auth.status === 'member' ? auth.member.id : null
  const status = auth.status === 'member' ? auth.member.status : null
  const isDeveloper = auth.status === 'member' ? (auth.roles ?? []).includes('developer') : false

  return useMemo(() => {
    if (memberId === null || status === null) return null
    const headOf = (departments.data ?? [])
      .filter((d) => d.lead_id === memberId && d.archived_at === null)
      .map((d) => d.key)
    return { id: memberId, status, isDeveloper, headOf }
  }, [memberId, status, isDeveloper, departments.data])
}
