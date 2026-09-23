import { useState, type ReactNode } from 'react'
import type { PrivilegedRole } from '../../auth/permissions.ts'
import { RoleDialog } from '../../roles/RoleDialog.tsx'
import { useMemberRoles } from '../../roles/useMemberRoles.ts'

// Privileged-role editing: its own data (useMemberRoles), its own dialog
// state, its own outcome message. RosterSettings composes this in — the
// "Change roles" button lives on each roster row, but everything about what
// happens when it is pressed is owned here (Phase 6 §6.1).
export function useRoleSettings(people: readonly { id: string; name: string }[]) {
  const memberRoles = useMemberRoles()
  const [roleTarget, setRoleTarget] = useState<{ id: string; name: string } | null>(null)
  const [roleMessage, setRoleMessage] = useState('')

  const rolesByMember = new Map<string, PrivilegedRole[]>()
  for (const row of memberRoles.data ?? []) {
    rolesByMember.set(row.member_id, [...(rolesByMember.get(row.member_id) ?? []), row.role])
  }

  const dialog: ReactNode = (
    <RoleDialog
      member={roleTarget}
      people={people}
      onClose={() => setRoleTarget(null)}
      onChanged={(message) => {
        setRoleTarget(null)
        setRoleMessage(message)
      }}
    />
  )

  return {
    rolesByMember,
    error: memberRoles.error,
    roleMessage,
    openFor: (id: string, name: string) => {
      setRoleMessage('')
      setRoleTarget({ id, name })
    },
    dialog,
  }
}
