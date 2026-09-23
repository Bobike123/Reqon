import type { ReactNode } from 'react'
import type { PrivilegedRole } from '../../auth/permissions.ts'
import { usePermissions } from '../../auth/usePermissions.ts'
import { useAddMember, useMembers, useUpdateMember, type MemberState } from '../../data/useMembers.ts'
import { RoleBadges } from '../../roles/RoleBadges.tsx'
import { buttonSecondary } from '../../ui/buttons.ts'
import { ActionError, ErrorState } from '../../ui/states.tsx'
import { useState, type FormEvent } from 'react'
import { JobTitleSelect } from './JobTitleSelect.tsx'
import { DEFAULT_JOB_TITLE, jobTitleOptions, splitRoster, type RosterMember } from './rosterModel.ts'
import { useRoleSettings } from './RoleSettings.tsx'

function RosterRow({
  member,
  roles,
  titles,
  tutorial,
  canAdminister,
  canManageRoles,
  onJobTitle,
  onStatus,
  onEditRoles,
  disabled,
}: {
  member: RosterMember
  roles: PrivilegedRole[]
  titles: readonly string[]
  // The one row the guided tour points at.
  tutorial: boolean
  canAdminister: boolean
  canManageRoles: boolean
  onJobTitle: (title: string) => void
  onStatus: (status: MemberState) => void
  onEditRoles: () => void
  disabled: boolean
}) {
  const retired = member.status === 'alumni'
  return (
    <li className="px-3 py-2" data-testid={`member-${member.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-sm font-medium ${retired ? 'text-slate-500' : 'text-slate-900'}`}>
          {member.full_name}
        </span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] whitespace-nowrap text-slate-700">
          <span className="sr-only">Job title: </span>
          {member.role}
        </span>
        <RoleBadges roles={roles} />
        {retired && (
          <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">alumni</span>
        )}
      </div>

      {/* Every control for this person in one row that wraps on a phone,
          instead of a lone button pushed to the edge. */}
      {(canAdminister || canManageRoles) && (
        <div
          className="mt-1.5 flex flex-wrap items-end gap-x-3 gap-y-2"
          data-tutorial={tutorial ? 'roster-controls' : undefined}
        >
          {canAdminister && (
            <>
              <span className="flex flex-col gap-0.5">
                {/* Visible label AND an sr-only one on the control: sighted
                    admins were editing a nameless text box before. */}
                <span aria-hidden="true" className="text-[11px] font-medium text-slate-600">
                  Job title
                </span>
                <JobTitleSelect
                  id={`title-${member.id}`}
                  label={`Job title for ${member.full_name}`}
                  titles={titles}
                  value={member.role}
                  disabled={disabled}
                  onChange={onJobTitle}
                />
              </span>
              <span className="flex flex-col gap-0.5">
                <span aria-hidden="true" className="text-[11px] font-medium text-slate-600">
                  Status
                </span>
                <label className="sr-only" htmlFor={`status-${member.id}`}>
                  Status for {member.full_name}
                </label>
                <select
                  id={`status-${member.id}`}
                  value={member.status}
                  disabled={disabled}
                  onChange={(e) => onStatus(e.target.value as MemberState)}
                  className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
                >
                  <option value="active">Active</option>
                  <option value="alumni">Alumni (retired)</option>
                </select>
              </span>
            </>
          )}
          {canManageRoles && (
            <span className="flex flex-col gap-0.5">
              <span aria-hidden="true" className="text-[11px] font-medium text-slate-600">
                Privileged roles
              </span>
              <button
                type="button"
                onClick={onEditRoles}
                aria-label={`Change roles for ${member.full_name}`}
                data-tutorial={tutorial ? 'change-roles' : undefined}
                className={`${buttonSecondary} text-xs`}
              >
                Change roles
              </button>
            </span>
          )}
        </div>
      )}
    </li>
  )
}

// The roster: who is on the team, their job title, their privileged roles
// (via RoleSettings.tsx), and the safe two-step "link an existing Auth
// account" form. Split out of the former Settings.tsx (Phase 6 §6.1) — owns
// its own members query, its own add/update mutations, its own form state.
//
// Asks usePermissions() itself rather than taking canAdminister/canManageRoles
// as props: a President who hands over their own role mid-session must see
// the "Change roles" buttons disappear the moment that lands, which needs
// this component to re-derive its OWN capabilities on its OWN re-render
// (triggered here by the role dialog's outcome message), not depend on an
// ancestor that has no other reason to re-render.
export function RosterSettings() {
  const { canAdminister, canManageRoles } = usePermissions()
  const members = useMembers()
  const addMember = useAddMember()
  const updateMember = useUpdateMember()
  const [newMember, setNewMember] = useState({ id: '', fullName: '', role: DEFAULT_JOB_TITLE })

  const roleSettings = useRoleSettings((members.data ?? []).map((m) => ({ id: m.id, name: m.full_name })))

  const { active, alumni } = splitRoster(members.data ?? [])
  const roster = [
    { heading: 'On the team', people: active, empty: 'Nobody is on the roster yet.' },
    { heading: 'Alumni', people: alumni, empty: 'Nobody has been retired yet.' },
    // An empty alumni group says nothing worth a heading; an empty team is
    // worth saying out loud.
  ].filter((group) => group.heading !== 'Alumni' || group.people.length > 0)

  const titles = jobTitleOptions(members.data ?? [], newMember.role)

  async function submitMember(e: FormEvent) {
    e.preventDefault()
    if (addMember.isPending || !newMember.id.trim() || !newMember.fullName.trim()) return
    try {
      await addMember.mutateAsync({
        id: newMember.id.trim(),
        fullName: newMember.fullName.trim(),
        role: newMember.role.trim() || DEFAULT_JOB_TITLE,
      })
      setNewMember({ id: '', fullName: '', role: DEFAULT_JOB_TITLE })
    } catch {
      // Refused or failed: the message is shown, and what was typed stays.
    }
  }

  const readError = members.error ?? roleSettings.error

  return (
    <>
      {readError && (
        <ErrorState
          title="Could not load the roster"
          error={readError}
          onRetry={() => {
            void members.refetch()
          }}
        />
      )}
      <ActionError error={addMember.error ?? updateMember.error} className="mb-2" />

      {/* The one sentence that makes the rest of this section readable. Two
          different things are called a "role" in this club, and the roster
          shows both on the same line. */}
      <p className="mb-2 text-xs text-pretty text-slate-600">
        A <strong className="font-medium text-slate-800">job title</strong> says what someone works
        on — Chassis, Aerodynamics, Finance. It is a label and grants nothing. A{' '}
        <strong className="font-medium text-slate-800">privileged role</strong> badge — President,
        Vice President, Treasurer, Developer — is what the database actually lets them do.
      </p>

      {roster.map((group) => (
        <div key={group.heading} className="mt-3 first:mt-0">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
            {group.heading}{' '}
            <span className="font-normal text-slate-500">({group.people.length})</span>
          </h3>
          {group.people.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-600">
              {group.empty}
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
              {group.people.map((m, index) => (
                <RosterRow
                  key={m.id}
                  member={m}
                  roles={roleSettings.rolesByMember.get(m.id) ?? []}
                  titles={titles}
                  tutorial={group.heading === 'On the team' && index === 0}
                  canAdminister={canAdminister}
                  canManageRoles={canManageRoles}
                  disabled={updateMember.isPending}
                  onJobTitle={(role) => {
                    if (role !== m.role) updateMember.mutate({ id: m.id, role })
                  }}
                  onStatus={(status) => updateMember.mutate({ id: m.id, status })}
                  onEditRoles={() => roleSettings.openFor(m.id, m.full_name)}
                />
              ))}
            </ul>
          )}
        </div>
      ))}

      <p className="mt-2 text-xs text-pretty text-slate-500">
        People are retired, never deleted — the database has no delete policy for the roster, so
        old task and rule owners keep resolving to a name forever. Alumni is a label, not a lock:
        to stop someone signing in, remove their login in the Supabase dashboard as well.
      </p>
      <p className="mt-1 text-xs text-pretty text-slate-500">
        The President and Vice President run these settings and the Treasurer changes money.
        A Developer can do all of it, roles included — the role exists so the app can be
        maintained and repaired, so give it out sparingly.{' '}
        {canManageRoles
          ? 'You can give or take away roles — and the club always keeps at least one President.'
          : 'Roles are given and taken away by the President or a Developer.'}
      </p>
      <p role="status" className="mt-1 min-h-4 text-xs font-medium text-emerald-800">
        {roleSettings.roleMessage}
      </p>
      {roleSettings.dialog as ReactNode}

      {canAdminister && (
        <form onSubmit={submitMember} className="mt-3 rounded-lg border border-slate-200 bg-white p-3" data-tutorial="add-member">
          <h3 className="text-sm font-medium text-slate-900">Add someone to the roster</h3>
          {/* This is the safe two-step process from the build brief. Creating
              an Auth account needs the service_role key, which bypasses RLS
              and must never be shipped to a browser. */}
          <ol className="mt-1 mb-2 list-decimal pl-5 text-xs text-slate-600">
            <li>
              In the Supabase dashboard: <strong>Authentication → Users → Add user</strong>.
              Give them an email and a password, and confirm the email.
            </li>
            <li>Copy the new user&apos;s <strong>UUID</strong> from that list.</li>
            <li>Paste it below. That links the login to the roster and grants access.</li>
          </ol>
          <p className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
            Accounts cannot be created from this app: doing so would require the
            service_role key in your browser, which would let anyone read and change
            the whole database.
          </p>
          <p className="mb-2 text-xs text-slate-600">
            Both steps in one go:{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5">supabase/scripts/new_member.sql</code>{' '}
            in the Supabase SQL Editor — fill in the five values at the top and run it.
          </p>
          <label className="block text-xs font-medium text-slate-600" htmlFor="new-member-id">
            Auth user UUID
          </label>
          <input
            id="new-member-id"
            value={newMember.id}
            onChange={(e) => setNewMember((s) => ({ ...s, id: e.target.value }))}
            placeholder="00000000-0000-0000-0000-000000000000"
            className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          />
          <label className="mt-2 block text-xs font-medium text-slate-600" htmlFor="new-member-name">
            Full name
          </label>
          <input
            id="new-member-name"
            value={newMember.fullName}
            onChange={(e) => setNewMember((s) => ({ ...s, fullName: e.target.value }))}
            className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          />
          <span aria-hidden="true" className="mt-2 block text-xs font-medium text-slate-600">
            Job title
          </span>
          {/* Same picker as the roster rows, so a new person gets one of the
              titles the club already uses rather than a fifth spelling of it. */}
          <div className="mt-1">
            <JobTitleSelect
              id="new-member-role"
              label="Job title"
              titles={titles}
              value={newMember.role}
              disabled={addMember.isPending}
              onChange={(role) => setNewMember((s) => ({ ...s, role }))}
            />
          </div>
          <button
            type="submit"
            disabled={addMember.isPending}
            className="mt-2 min-h-11 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
          >
            {addMember.isPending ? 'Linking…' : 'Link to roster'}
          </button>
        </form>
      )}
    </>
  )
}
