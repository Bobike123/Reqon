import { useAuth } from './context.ts'
import { NO_PERMISSIONS, permissionsFor, type Permissions } from './permissions.ts'

// The signed-in person's permissions. Use this in components instead of
// looking at roles directly — `usePermissions().canManageRoles`, never
// `roles.includes('president')` — so every rule lives in permissions.ts.
export function usePermissions(): Permissions {
  const auth = useAuth()
  if (auth.status !== 'member') return NO_PERMISSIONS
  // A retired member keeps their roster row and may keep a role, but the
  // database counts a role only while its holder is active (has_role(), 20260118),
  // so the screen must not offer what would be refused.
  if (auth.member.status === 'alumni') return { ...NO_PERMISSIONS, canSuggestProposal: false }
  return permissionsFor(auth.roles ?? [])
}
