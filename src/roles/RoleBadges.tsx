import { ROLE_LABELS, sortRoles, type PrivilegedRole } from '../auth/permissions.ts'

// Each role gets its own quiet tint so they are easy to tell apart at a glance,
// but the WORD is what carries the meaning — colour is never the only signal.
const TINT: Record<PrivilegedRole, string> = {
  president: 'bg-slate-900 text-white ring-slate-900',
  vicepresident: 'bg-slate-100 text-slate-800 ring-slate-300',
  treasurer: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  developer: 'bg-sky-50 text-sky-800 ring-sky-200',
}

export function RoleBadges({ roles }: { roles: readonly PrivilegedRole[] }) {
  const ordered = sortRoles(roles)
  if (ordered.length === 0) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="sr-only">Roles: </span>
      {ordered.map((role) => (
        <span
          key={role}
          className={`rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${TINT[role]}`}
        >
          {ROLE_LABELS[role]}
        </span>
      ))}
    </span>
  )
}
