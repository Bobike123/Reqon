import type { Database } from '../lib/database.types.ts'

export type PrivilegedRole = Database['public']['Enums']['privileged_role']

// Display order and wording, used wherever roles are shown. People never see
// the raw database value ('vicepresident').
export const PRIVILEGED_ROLES: readonly PrivilegedRole[] = [
  'president',
  'vicepresident',
  'treasurer',
  'developer',
]

export const ROLE_LABELS: Record<PrivilegedRole, string> = {
  president: 'President',
  vicepresident: 'Vice President',
  treasurer: 'Treasurer',
  developer: 'Developer',
}

// What each role may do, in one line — shown where roles are handed out.
export const ROLE_SUMMARIES: Record<PrivilegedRole, string> = {
  president: 'Runs Settings, and is the only role that can give or take away roles.',
  vicepresident: 'Runs Settings like the President, but cannot change roles.',
  treasurer: 'The only role that can add, edit or delete financial entries.',
  developer: 'Full access, for maintenance: everything the other three roles can do, roles included.',
}

// Someone on the roster who holds no privileged role.
export const NO_ROLE_LABEL = 'Member'

export function sortRoles(roles: readonly PrivilegedRole[]): PrivilegedRole[] {
  return PRIVILEGED_ROLES.filter((role) => roles.includes(role))
}

// "President", "Treasurer and Developer", or "Member (no privileged role)".
export function describeRoles(roles: readonly PrivilegedRole[]): string {
  const labels = sortRoles(roles).map((role) => ROLE_LABELS[role])
  if (labels.length === 0) return `${NO_ROLE_LABEL} (no privileged role)`
  if (labels.length === 1) return labels[0]
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

// What the signed-in person may do — the ONE place the app decides it.
//
// This is a mirror of the SQL functions in
// supabase/migrations/20260105000000_privileged_roles.sql, and it is used only
// to decide what to SHOW. The database checks every one of these again on
// every request, so editing this file in the browser changes which buttons
// appear, never what is allowed. If you change a rule, change the SQL first.
export type Permissions = {
  roles: readonly PrivilegedRole[]
  hasRole: (role: PrivilegedRole) => boolean
  // is_admin(): rulebook, subsystems, roster, seasons, milestones
  canAdminister: boolean
  // can_manage_roles(): assign and remove privileged roles
  canManageRoles: boolean
  // can_view_finances(): see financial records
  canViewFinances: boolean
  // can_manage_finances(): create, edit and delete financial records
  canManageFinances: boolean
}

export function permissionsFor(roles: readonly PrivilegedRole[]): Permissions {
  const held = new Set(roles)
  const hasRole = (role: PrivilegedRole) => held.has(role)
  return {
    roles,
    hasRole,
    // The developer passes every check, for maintenance and security work:
    // supabase/migrations/20260107000000_developer_full_access.sql.
    canAdminister: hasRole('president') || hasRole('vicepresident') || hasRole('developer'),
    canManageRoles: hasRole('president') || hasRole('developer'),
    canViewFinances: held.size > 0,
    canManageFinances: hasRole('treasurer') || hasRole('developer'),
  }
}

export const NO_PERMISSIONS: Permissions = permissionsFor([])
