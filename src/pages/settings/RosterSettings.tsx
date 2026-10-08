import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { canGrantRole, type PrivilegedRole } from '../../auth/permissions.ts'
import { usePermissions } from '../../auth/usePermissions.ts'
import { useAddMember, useCreateMember, useMembers, useUpdateMember, type MemberState } from '../../data/useMembers.ts'
import { useSubteams } from '../../data/useSubteams.ts'
import { isActive } from '../../departments/types.ts'
import { mergeSearchParams } from '../../lib/searchParams.ts'
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
  statusLocked = false,
  heads,
  canManageDepartments,
}: {
  member: RosterMember
  roles: PrivilegedRole[]
  // Active departments this person is Head of (subteams.lead_id).
  heads: { key: string; name: string }[]
  canManageDepartments: boolean
  titles: readonly string[]
  // The one row the guided tour points at.
  tutorial: boolean
  canAdminister: boolean
  canManageRoles: boolean
  onJobTitle: (title: string) => void
  onStatus: (status: MemberState) => void
  onEditRoles: () => void
  disabled: boolean
  statusLocked?: boolean
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
      {/* Headship is a third, separate thing: set on the department, not on
          the person, so it is changed from the department's own editor. */}
      {heads.length > 0 && (
        <p className="group mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-700" data-testid={`headship-${member.id}`}>
          <span>
            <span className="text-slate-500">Head of Department: </span>
            {heads.map((d) => d.name).join(', ')}
            {retired && ' (no longer active — reassign)'}
          </span>
          {canManageDepartments &&
            heads.map((d) => (
              <Link
                key={d.key}
                to={`/settings?${mergeSearchParams(new URLSearchParams(), { edit: `department:${d.key}` }).toString()}`}
                aria-label={`Edit ${d.name}`}
                className="underline underline-offset-2 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 pointer-coarse:opacity-100"
              >
                Edit {heads.length > 1 ? d.name : 'department'}
              </Link>
            ))}
        </p>
      )}

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
                  disabled={disabled || statusLocked}
                  title={statusLocked ? 'Only someone who may change all of this person’s roles can change their status.' : undefined}
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
const EMPTY_RECRUIT = { email: '', password: '', fullName: '', role: DEFAULT_JOB_TITLE }

// Asks usePermissions() itself rather than taking canAdminister/canManageRoles
// as props: a President who hands over their own role mid-session must see
// the "Change roles" buttons disappear the moment that lands, which needs
// this component to re-derive its OWN capabilities on its OWN re-render
// (triggered here by the role dialog's outcome message), not depend on an
// ancestor that has no other reason to re-render.
export function RosterSettings() {
  const { canAdminister, canAddMembers, canManageRoles, canManageDepartments, canManageSeasons, roles: myRoles } = usePermissions()
  const members = useMembers()
  const subteams = useSubteams()
  const headsOf = (memberId: string) =>
    (subteams.data ?? []).filter((d) => isActive(d) && d.lead_id === memberId).map((d) => ({ key: d.key, name: d.name }))
  const addMember = useAddMember()
  const createMember = useCreateMember()
  const updateMember = useUpdateMember()
  const [newMember, setNewMember] = useState({ id: '', fullName: '', role: DEFAULT_JOB_TITLE })
  const [recruit, setRecruit] = useState(EMPTY_RECRUIT)
  const [createdMessage, setCreatedMessage] = useState('')

  const roleSettings = useRoleSettings((members.data ?? []).map((m) => ({ id: m.id, name: m.full_name })))

  const { active, alumni } = splitRoster(members.data ?? [])
  const roster = [
    { heading: 'On the team', people: active, empty: 'Nobody is on the roster yet.' },
    { heading: 'Alumni', people: alumni, empty: 'Nobody has been retired yet.' },
    // An empty alumni group says nothing worth a heading; an empty team is
    // worth saying out loud.
  ].filter((group) => group.heading !== 'Alumni' || group.people.length > 0)

  const titles = jobTitleOptions(members.data ?? [], newMember.role, recruit.role)

  async function submitRecruit(e: FormEvent) {
    e.preventDefault()
    if (createMember.isPending) return
    const fullName = recruit.fullName.trim()
    const email = recruit.email.trim()
    if (!fullName || !email || !recruit.password) return
    setCreatedMessage('')
    try {
      await createMember.mutateAsync({
        email,
        password: recruit.password,
        fullName,
        jobTitle: recruit.role.trim() || DEFAULT_JOB_TITLE,
      })
      // The password is cleared at once; only the instruction stays on screen.
      setRecruit(EMPTY_RECRUIT)
      setCreatedMessage(
        `${fullName} is on the roster. They sign in with ${email} and the password you chose, then change it in Settings → Your account.`,
      )
    } catch {
      // Refused or failed: the message is shown, and what was typed stays.
    }
  }

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
        <strong className="font-medium text-slate-800">privileged role</strong> badge — for example,
        President, Vice President or Treasurer — is what the database actually lets them do.{' '}
        <strong className="font-medium text-slate-800">Head of Department</strong> is set on the
        department, and lets them review its proposals and manage its tasks.
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
                  // guard_member_edit(): changing a role holder's status needs
                  // can_grant_role() for every role they hold.
                  statusLocked={(roleSettings.rolesByMember.get(m.id) ?? []).some((r) => !canGrantRole(myRoles, r))}
                  onJobTitle={(role) => {
                    if (role !== m.role) updateMember.mutate({ id: m.id, role })
                  }}
                  onStatus={(status) => updateMember.mutate({ id: m.id, status })}
                  onEditRoles={() => roleSettings.openFor(m.id, m.full_name)}
                  heads={headsOf(m.id)}
                  canManageDepartments={canManageDepartments}
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
        The President and Vice President run these settings and the Treasurer changes money.{' '}
        {canManageRoles && canManageSeasons
          ? 'You can give or take away the roles available to you, and the club always keeps at least one President.'
          : canManageRoles
            ? 'You can give or take away the Treasurer and Documentation roles; the President handles the others.'
            : 'Roles are given and taken away by the President or Vice President.'}
      </p>
      <p role="status" className="mt-1 min-h-4 text-xs font-medium text-emerald-800">
        {roleSettings.roleMessage}
      </p>
      {roleSettings.dialog as ReactNode}

      {canAddMembers && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3" data-tutorial="add-member">
          <form onSubmit={submitRecruit} aria-labelledby="add-member-heading">
            <h3 id="add-member-heading" className="text-sm font-medium text-slate-900">
              Add someone to the roster
            </h3>
            {/* The login is made by the create-member Edge Function, the only
                place the service_role key lives. This browser sends only your
                own session; the database checks can_add_members() for you. */}
            <p className="mt-1 mb-2 text-xs text-pretty text-slate-600">
              This creates their login and puts them on the roster in one step. They start with no
              privileged role — give one afterwards with <strong>Change roles</strong> if needed.
            </p>
            <label className="block text-xs font-medium text-slate-600" htmlFor="recruit-name">
              Full name
            </label>
            <input
              id="recruit-name"
              required
              maxLength={120}
              autoComplete="off"
              value={recruit.fullName}
              onChange={(e) => setRecruit((s) => ({ ...s, fullName: e.target.value }))}
              className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            />
            <label className="mt-2 block text-xs font-medium text-slate-600" htmlFor="recruit-email">
              Email they sign in with
            </label>
            <input
              id="recruit-email"
              type="email"
              required
              maxLength={254}
              autoComplete="off"
              value={recruit.email}
              onChange={(e) => setRecruit((s) => ({ ...s, email: e.target.value }))}
              className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            />
            <label className="mt-2 block text-xs font-medium text-slate-600" htmlFor="recruit-password">
              First password
            </label>
            <input
              id="recruit-password"
              type="password"
              required
              minLength={8}
              maxLength={72}
              autoComplete="new-password"
              aria-describedby="recruit-password-hint"
              value={recruit.password}
              onChange={(e) => setRecruit((s) => ({ ...s, password: e.target.value }))}
              className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            />
            <p id="recruit-password-hint" className="mt-1 text-xs text-slate-500">
              At least 8 characters. Give it to them privately; they change it in Settings → Your account.
            </p>
            <span aria-hidden="true" className="mt-2 block text-xs font-medium text-slate-600">
              Job title
            </span>
            {/* Same picker as the roster rows, so a new person gets one of the
                titles the club already uses rather than a fifth spelling of it. */}
            <div className="mt-1">
              <JobTitleSelect
                id="recruit-role"
                label="Job title"
                titles={titles}
                value={recruit.role}
                disabled={createMember.isPending}
                onChange={(role) => setRecruit((s) => ({ ...s, role }))}
              />
            </div>
            <button
              type="submit"
              disabled={createMember.isPending}
              className="mt-2 min-h-11 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
            >
              {createMember.isPending ? 'Adding…' : 'Add to roster'}
            </button>
            {/* Its own slot, so a stale create error never hides a later
                roster-row or link error shown above. */}
            <ActionError error={createMember.error} className="mt-2" />
            <p role="status" className="mt-1 min-h-4 text-xs font-medium text-emerald-800">
              {createdMessage}
            </p>
          </form>

          {/* The older path, kept for a login that already exists — made in the
              Supabase dashboard, or left over from before this form. */}
          <details className="mt-2 border-t border-slate-200 pt-2">
            <summary className="cursor-pointer text-xs font-medium text-slate-700">
              Their login already exists? Link it by UUID
            </summary>
            <form onSubmit={submitMember} className="mt-2">
              <p className="mb-2 text-xs text-slate-600">
                Copy the user&apos;s <strong>UUID</strong> from the Supabase dashboard
                (<strong>Authentication → Users</strong>) and paste it below.
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
                Full name of the linked person
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
              <div className="mt-1">
                <JobTitleSelect
                  id="new-member-role"
                  label="Job title of the linked person"
                  titles={titles}
                  value={newMember.role}
                  disabled={addMember.isPending}
                  onChange={(role) => setNewMember((s) => ({ ...s, role }))}
                />
              </div>
              <button
                type="submit"
                disabled={addMember.isPending}
                className={`${buttonSecondary} mt-2 text-sm`}
              >
                {addMember.isPending ? 'Linking…' : 'Link to roster'}
              </button>
            </form>
          </details>
        </div>
      )}
    </>
  )
}
