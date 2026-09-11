import { useAuth } from './context.ts'
import { NO_PERMISSIONS, permissionsFor, type Permissions } from './permissions.ts'

// The signed-in person's permissions. Use this in components instead of
// looking at roles directly — `usePermissions().canManageRoles`, never
// `roles.includes('president')` — so every rule lives in permissions.ts.
export function usePermissions(): Permissions {
  const auth = useAuth()
  if (auth.status !== 'member') return NO_PERMISSIONS
  return permissionsFor(auth.roles ?? [])
}
