import { PageHeader } from '../ui/PageHeader.tsx'
import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/context.ts'
import { describeRoles, type PrivilegedRole } from '../auth/permissions.ts'
import { usePermissions } from '../auth/usePermissions.ts'
import { RoleBadges } from '../roles/RoleBadges.tsx'
import { RoleDialog } from '../roles/RoleDialog.tsx'
import { buttonSecondary } from '../ui/buttons.ts'
import { ActionError, ErrorState, LoadingState } from '../ui/states.tsx'
import { buildSeasonExport, downloadJson } from '../data/exportSeason.ts'
import { useCurrentSeason } from '../data/useCurrentSeason.ts'
import { useMembers } from '../data/useMembers.ts'
import { useMilestones, useSubteams } from '../data/useMilestones.ts'
import {
  useAddMember,
  useCreateSeason,
  useHandoverNotes,
  useMemberRoles,
  useSeasons,
  useSetCurrentSeason,
  useSetHandoverNote,
  useUpdateMember,
  useUpdateMilestone,
  useUpdateSubteam,
} from '../data/useSettings.ts'

// Settings. Admin-only actions are hidden from everyone else here AS A
// COURTESY — the actual authorization is in the database
// (supabase/migrations/20260105000000_privileged_roles.sql):
//
//   members      INSERT  -> admin_roster_insert (is_admin(): president or vice-president)
//   members      UPDATE  -> member_self_update  (own row, or is_admin())
//   members      DELETE  -> no policy at all: people cannot be deleted, ever
//   subteams     ALL     -> admin_write         (is_admin())
//   milestones   ALL     -> admin_write         (is_admin())
//   seasons      ALL     -> admin_write         (is_admin())
//   season switch        -> set_current_season() raises unless is_admin()
//   member_roles INSERT  -> role_assign         (can_manage_roles(): the president only)
//   member_roles DELETE  -> role_remove         (the president only; never the last one)
//
// What to show comes from usePermissions() — this file never inspects roles to
// decide access. Editing it to un-hide a button gets you a rejected request,
// not access.

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6" aria-labelledby={`s-${title.replace(/\s+/g, '-')}`}>
      <h2
        id={`s-${title.replace(/\s+/g, '-')}`}
        className="mb-2 text-sm font-semibold text-slate-900"
      >
        {title}
      </h2>
      {children}
    </section>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
      {children}
    </p>
  )
}

export default function Settings() {
  const auth = useAuth()
  const { canAdminister, canManageRoles, roles: myRoles } = usePermissions()
  const myId = auth.status === 'member' ? auth.member.id : null

  const members = useMembers()
  const subteams = useSubteams()
  const milestones = useMilestones()
  const seasons = useSeasons()
  const currentSeason = useCurrentSeason()
  const notes = useHandoverNotes()
  const memberRoles = useMemberRoles()

  const addMember = useAddMember()
  const updateMember = useUpdateMember()
  const updateSubteam = useUpdateSubteam()
  const updateMilestone = useUpdateMilestone()
  const createSeason = useCreateSeason()
  const setCurrent = useSetCurrentSeason()
  const setNote = useSetHandoverNote()
  // Whose roles the President is editing, and the outcome of the last change.
  const [roleTarget, setRoleTarget] = useState<{ id: string; name: string } | null>(null)
  const [roleMessage, setRoleMessage] = useState('')

  const [newMember, setNewMember] = useState({ id: '', fullName: '', role: '' })
  const [newSeason, setNewSeason] = useState({ label: '', edition: '' })
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const writeError =
    addMember.error ?? updateMember.error ?? updateSubteam.error ??
    updateMilestone.error ?? createSeason.error ?? setCurrent.error ?? setNote.error

  // Reads can fail too — without this the screen rendered empty lists as though
  // the club simply had no members and no seasons.
  const readError =
    members.error ?? subteams.error ?? milestones.error ?? seasons.error ?? notes.error ??
    memberRoles.error
  const loading = members.isLoading || subteams.isLoading || seasons.isLoading

  // Who holds which privileged role — for display only.
  const rolesByMember = new Map<string, PrivilegedRole[]>()
  for (const row of memberRoles.data ?? []) {
    rolesByMember.set(row.member_id, [...(rolesByMember.get(row.member_id) ?? []), row.role])
  }

  async function submitMember(e: FormEvent) {
    e.preventDefault()
    if (addMember.isPending || !newMember.id.trim() || !newMember.fullName.trim()) return
    try {
      await addMember.mutateAsync({
        id: newMember.id.trim(),
        fullName: newMember.fullName.trim(),
        role: newMember.role.trim() || 'Member',
      })
      setNewMember({ id: '', fullName: '', role: '' })
    } catch {
      // Refused or failed: the message is shown, and what was typed stays.
    }
  }

  async function submitSeason(e: FormEvent) {
    e.preventDefault()
    if (createSeason.isPending || !newSeason.label.trim()) return
    try {
      await createSeason.mutateAsync({ label: newSeason.label.trim(), edition: newSeason.edition.trim() || null })
      setNewSeason({ label: '', edition: '' })
    } catch {
      // Refused or failed: the message is shown, and what was typed stays.
    }
  }

  async function doExport() {
    if (!currentSeason.data?.id) return
    setExporting(true)
    setExportError(null)
    try {
      const data = await buildSeasonExport(currentSeason.data.id)
      const label = String(currentSeason.data.label ?? 'season').replace(/\W+/g, '-')
      downloadJson(`paddock-control-${label}-${new Date().toISOString().slice(0, 10)}.json`, data)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-3 py-4 sm:px-6 *:max-w-3xl">
      <PageHeader
        title="Settings"
        description="The roster, subsystems, milestone dates, handover notes and seasons."
        tutorialId="settings-overview"
      />

      {/* What this person can do here, in words — never left to be inferred
          from which buttons happen to be missing. */}
      <Notice>
        Signed in as <strong className="font-medium text-slate-900">{describeRoles(myRoles)}</strong>.{' '}
        {canManageRoles
          ? 'You can change everything on this page, including who holds which role.'
          : canAdminister
            ? 'You can change everything on this page except roles, which only the President can give or take away.'
            : 'Roster, subsystem, milestone and season changes are reserved for the President and Vice President — the database enforces this, so those forms are hidden rather than shown and refused. Handover notes below are open to everyone.'}
      </Notice>

      {readError && (
        <div className="mt-3">
          <ErrorState
            title="Could not load settings"
            error={readError}
            onRetry={() => {
              void members.refetch()
              void subteams.refetch()
              void milestones.refetch()
              void seasons.refetch()
              void notes.refetch()
              void memberRoles.refetch()
            }}
          />
        </div>
      )}

      {loading && !readError && <LoadingState label="Loading settings…" />}

      <ActionError error={writeError} className="mt-3" />

      {/* ---------------------------------------------------------- Roster */}
      <Section title="Roster">
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {(members.data ?? []).map((m) => (
            <li key={m.id} className="px-3 py-2" data-testid={`member-${m.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-sm ${m.status === 'alumni' ? 'text-slate-600 line-through' : 'text-slate-900'}`}>
                  {m.full_name}
                </span>
                <span className="text-xs text-slate-500">{m.role}</span>
                <RoleBadges roles={rolesByMember.get(m.id) ?? []} />
                {m.status === 'alumni' && (
                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">
                    alumni
                  </span>
                )}
              </div>
              {/* Every control for this person in one row that wraps on a
                  phone, instead of a lone button pushed to the edge. */}
              {(canAdminister || canManageRoles) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  {canManageRoles && (
                    <button
                      type="button"
                      onClick={() => {
                        setRoleMessage('')
                        setRoleTarget({ id: m.id, name: m.full_name })
                      }}
                      aria-label={`Change roles for ${m.full_name}`}
                      className={buttonSecondary}
                    >
                      Change roles
                    </button>
                  )}
                  {canAdminister && (
                  <>
                  <label className="sr-only" htmlFor={`status-${m.id}`}>
                    Status for {m.full_name}
                  </label>
                  <select
                    id={`status-${m.id}`}
                    value={m.status}
                    onChange={(e) =>
                      updateMember.mutate({ id: m.id, status: e.target.value as 'active' | 'alumni' })
                    }
                    className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                  >
                    <option value="active">Active</option>
                    <option value="alumni">Alumni (retired)</option>
                  </select>
                  <label className="sr-only" htmlFor={`title-${m.id}`}>Job title for {m.full_name}</label>
                  <input
                    id={`title-${m.id}`}
                    defaultValue={m.role}
                    onBlur={(e) => {
                      if (e.target.value !== m.role) updateMember.mutate({ id: m.id, role: e.target.value })
                    }}
                    className="min-h-11 rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                  />
                  </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-slate-500">
          People are retired, never deleted — the database has no delete policy for the
          roster, so old task and rule owners keep resolving to a name forever.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          The President and Vice President run these settings, the Treasurer is the only one
          who can change money, and a Developer can see everything without extra rights to
          change it.{' '}
          {canManageRoles
            ? 'Only you, as President, can give or take away roles — and the club always keeps at least one President.'
            : 'Roles are given and taken away by the President.'}
        </p>
        <p role="status" className="mt-1 min-h-4 text-xs font-medium text-emerald-800">
          {roleMessage}
        </p>
        <RoleDialog
          member={roleTarget}
          people={(members.data ?? []).map((m) => ({ id: m.id, name: m.full_name }))}
          onClose={() => setRoleTarget(null)}
          onChanged={(message) => {
            setRoleTarget(null)
            setRoleMessage(message)
          }}
        />

        {canAdminister && (
          <form onSubmit={submitMember} className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
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
            <label className="mt-2 block text-xs font-medium text-slate-600" htmlFor="new-member-role">
              Job title
            </label>
            <input
              id="new-member-role"
              value={newMember.role}
              onChange={(e) => setNewMember((s) => ({ ...s, role: e.target.value }))}
              placeholder="Engineer"
              className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            />
            <button
              type="submit"
              disabled={addMember.isPending}
              className="mt-2 min-h-11 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
            >
              {addMember.isPending ? 'Linking…' : 'Link to roster'}
            </button>
          </form>
        )}
      </Section>

      {/* -------------------------------------------------------- Subteams */}
      {canAdminister && (
        <Section title="Subsystems">
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {(subteams.data ?? []).map((s) => (
              <li key={s.key} className="px-3 py-2" data-testid={`subteam-row-${s.key}`}>
                <span className="font-mono text-xs text-slate-500">{s.key}</span>
                <div className="mt-1 flex flex-wrap gap-2">
                  <label className="sr-only" htmlFor={`sub-name-${s.key}`}>Name for {s.key}</label>
                  <input
                    id={`sub-name-${s.key}`}
                    defaultValue={s.name}
                    onBlur={(e) => {
                      if (e.target.value !== s.name) updateSubteam.mutate({ key: s.key, name: e.target.value })
                    }}
                    className="min-h-11 flex-1 rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                  />
                  <label className="sr-only" htmlFor={`sub-lead-${s.key}`}>Lead for {s.key}</label>
                  <select
                    id={`sub-lead-${s.key}`}
                    value={s.lead_id ?? ''}
                    onChange={(e) => updateSubteam.mutate({ key: s.key, leadId: e.target.value || null })}
                    className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                  >
                    <option value="">No lead</option>
                    {(members.data ?? []).map((m) => (
                      <option key={m.id} value={m.id}>{m.full_name}</option>
                    ))}
                  </select>
                </div>
                <label className="sr-only" htmlFor={`sub-desc-${s.key}`}>Description for {s.key}</label>
                <input
                  id={`sub-desc-${s.key}`}
                  defaultValue={s.description ?? ''}
                  placeholder="What this subsystem covers"
                  onBlur={(e) => {
                    if (e.target.value !== (s.description ?? '')) {
                      updateSubteam.mutate({ key: s.key, description: e.target.value || null })
                    }
                  }}
                  className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ------------------------------------------------------ Milestones */}
      {canAdminister && (
        <Section title="Milestone dates and points">
          <p className="mb-2 text-xs text-slate-500">
            For a new edition. Leaving a due date blank is valid — it renders as TBC.
          </p>
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {(milestones.data ?? []).map((m) => (
              <li key={m.key} className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid={`ms-row-${m.key}`}>
                <span className="w-32 shrink-0 text-sm text-slate-900">
                  <span className="font-mono text-xs">{m.key}</span> {m.name}
                </span>
                <label className="sr-only" htmlFor={`ms-opens-${m.key}`}>Opens on for {m.key}</label>
                <input
                  id={`ms-opens-${m.key}`} type="date" defaultValue={m.opens_on ?? ''}
                  onBlur={(e) => {
                    if (e.target.value !== (m.opens_on ?? '')) {
                      updateMilestone.mutate({ key: m.key, opensOn: e.target.value || null })
                    }
                  }}
                  className="min-h-11 rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                />
                <label className="sr-only" htmlFor={`ms-due-${m.key}`}>Due on for {m.key}</label>
                <input
                  id={`ms-due-${m.key}`} type="date" defaultValue={m.due_on ?? ''}
                  onBlur={(e) => {
                    if (e.target.value !== (m.due_on ?? '')) {
                      updateMilestone.mutate({ key: m.key, dueOn: e.target.value || null })
                    }
                  }}
                  className="min-h-11 rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                />
                <label className="sr-only" htmlFor={`ms-points-${m.key}`}>Max points for {m.key}</label>
                <input
                  id={`ms-points-${m.key}`} type="number" min={0} defaultValue={m.max_points}
                  onBlur={(e) => {
                    const n = Number(e.target.value)
                    if (Number.isFinite(n) && n !== m.max_points) {
                      updateMilestone.mutate({ key: m.key, maxPoints: n })
                    }
                  }}
                  className="min-h-11 w-20 rounded border border-slate-300 px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
                />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* -------------------------------------------------- Handover notes */}
      <Section title="Handover notes">
        <p className="mb-2 text-xs text-slate-500">
          One note per subsystem, for whoever picks this up next year. Saved when you
          click away.
        </p>
        <ul className="space-y-2">
          {(subteams.data ?? []).map((s) => {
            const note = (notes.data ?? []).find((n) => n.subteam_key === s.key)
            return (
              <li key={s.key} className="rounded-lg border border-slate-200 bg-white p-3">
                <label className="block text-xs font-medium text-slate-700" htmlFor={`note-${s.key}`}>
                  {s.name}
                </label>
                <textarea
                  id={`note-${s.key}`}
                  aria-labelledby={undefined}
                  rows={2}
                  defaultValue={note?.body ?? ''}
                  placeholder="What the next person needs to know…"
                  onBlur={(e) => {
                    if (!myId) return
                    if (e.target.value !== (note?.body ?? '')) {
                      setNote.mutate({ subteamKey: s.key, body: e.target.value, memberId: myId })
                    }
                  }}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                />
              </li>
            )
          })}
        </ul>
      </Section>

      {/* --------------------------------------------------------- Seasons */}
      <Section title="Seasons">
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {(seasons.data ?? []).map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid={`season-${s.id}`}>
              <span className="text-sm text-slate-900">{s.label}</span>
              {s.is_current && (
                <span className="rounded bg-green-700 px-1.5 py-0.5 text-[11px] font-medium text-white" data-testid={`current-${s.id}`}>
                  current
                </span>
              )}
              {canAdminister && !s.is_current && (
                <button
                  type="button"
                  disabled={setCurrent.isPending}
                  onClick={() => setCurrent.mutate(s.id)}
                  data-testid={`make-current-${s.id}`}
                  className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
                >
                  {setCurrent.isPending ? 'Switching…' : 'Make current'}
                </button>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-slate-500">
          Switching runs in a single database transaction, so the club can never end up
          with two current seasons — or none. Old seasons stay readable.
        </p>

        {canAdminister && (
          <form onSubmit={submitSeason} className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
            <h3 className="text-sm font-medium text-slate-900">Start a new season</h3>
            <p className="mt-0.5 mb-2 text-xs text-slate-600">
              The new season starts empty: the rulebook carries over untouched, and none
              of this year&apos;s progress is copied. Nothing becomes current until you
              press “Make current”.
            </p>
            <label className="block text-xs font-medium text-slate-600" htmlFor="new-season-label">Label</label>
            <input
              id="new-season-label"
              value={newSeason.label}
              onChange={(e) => setNewSeason((s) => ({ ...s, label: e.target.value }))}
              placeholder="2028/29"
              className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            />
            <label className="mt-2 block text-xs font-medium text-slate-600" htmlFor="new-season-edition">
              Edition (optional)
            </label>
            <input
              id="new-season-edition"
              value={newSeason.edition}
              onChange={(e) => setNewSeason((s) => ({ ...s, edition: e.target.value }))}
              placeholder="X"
              className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
            />
            <button
              type="submit"
              disabled={createSeason.isPending}
              className="mt-2 min-h-11 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
            >
              {createSeason.isPending ? 'Creating…' : 'Create season'}
            </button>
          </form>
        )}
      </Section>

      {/* ---------------------------------------------------------- Export */}
      <Section title="Export">
        <p className="mb-2 text-xs text-slate-500">
          Everything this season, as one JSON file. Roster names and roles are included so
          owner ids resolve; no passwords, emails or keys are.
        </p>
        {exportError && (
          <p role="alert" className="mb-2 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
            {exportError}
          </p>
        )}
        <button
          type="button"
          onClick={() => void doExport()}
          disabled={exporting || !currentSeason.data}
          data-testid="export-button"
          className="min-h-11 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
        >
          {exporting ? 'Preparing…' : 'Download season JSON'}
        </button>
      </Section>
    </main>
  )
}
