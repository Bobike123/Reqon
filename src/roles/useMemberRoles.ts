import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { supabase } from '../lib/supabase.ts'
import type { Database } from '../lib/database.types.ts'
import { DataError } from '../core/errors.ts'
import { queryKeys } from '../data/queryKeys.ts'
import { unwrap } from '../data/errors.ts'
import type { RoleChange } from './rolePlan.ts'

// Privileged-role reads and writes. Moved out of data/useSettings.ts (Phase 6
// §6.2): these are transactional authorization commands, not settings-screen
// data — they belong in the same boundary as RoleDialog.tsx and rolePlan.ts,
// not filed under a route.

export type MemberRole = Database['public']['Tables']['member_roles']['Row']

export const roleKeys = {
  all: queryKeys.memberRoles,
  list: [...queryKeys.memberRoles, 'all'] as const,
}

// Who holds which role. Everyone on the roster may read this (role_read).
// Re-read every minute and on returning to the tab, so a change the President
// makes on another device shows up without a reload.
export function useMemberRoles(): UseQueryResult<MemberRole[], Error> {
  return useQuery({
    queryKey: roleKeys.list,
    queryFn: async () =>
      unwrap('load member roles', await supabase.from('member_roles').select('*')),
    refetchInterval: 60_000,
  })
}

// Applies a plan from rolePlan.ts as ONE transaction, via the
// apply_role_plan() database function (20260111000000_atomic_role_plan.sql):
// every change lands, or none does. Previously this looped giveRole/takeRole
// one write at a time and stopped at the first refusal — which could leave a
// hand-over half done (the new President granted, the old one not yet
// stepped down, and a dropped connection in between) since each write was its
// own round trip. A single RPC call is atomic in the database itself; there
// is no partial-application case left to report.
export function useApplyRoleChanges() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, RoleChange[]>({
    mutationFn: async (changes) => {
      if (changes.length === 0) return
      const { error } = await supabase.rpc('apply_role_plan', {
        p_changes: changes.map((c) => ({ member_id: c.memberId, role: c.role, action: c.action })),
      })
      if (error) throw new DataError('change privileged roles', error)
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: roleKeys.all }),
  })
}
