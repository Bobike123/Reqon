import type { ReactNode } from 'react'
import { PageHeader } from '../ui/PageHeader.tsx'
import { usePermissions } from '../auth/usePermissions.ts'
import { pageMain } from '../ui/layout.ts'
import { AccountSettings } from './settings/AccountSettings.tsx'
import { RosterSettings } from './settings/RosterSettings.tsx'
import { DepartmentSettings } from './settings/DepartmentSettings.tsx'
import { MilestoneSettings } from './settings/MilestoneSettings.tsx'
import { HandoverSettings } from './settings/HandoverSettings.tsx'
import { BookSettings } from './settings/BookSettings.tsx'
import { SeasonSettings } from './settings/SeasonSettings.tsx'
import { SeasonExport } from './settings/SeasonExport.tsx'
import { attachmentsEnabled } from '../attachments/flag.ts'
import { StorageUsage } from '../attachments/StorageUsage.tsx'
import { backupsEnabled } from '../backups/flag.ts'
import { BackupsGuide } from '../backups/BackupsGuide.tsx'
import { BackupsPanel } from '../backups/BackupsPanel.tsx'

// The route shell (Phase 6 §6.1): coordinates only what genuinely is shared
// between sections — the page chrome, and the one capability summary that
// describes the WHOLE page at a glance. Every section below owns its own
// data queries, mutations, pending state, action errors and form state; the
// shell does not read a single row of data itself.
//
// Admin-only actions are hidden from everyone else here AS A COURTESY — the
// actual authorization is in the database
// (supabase/migrations/20260105000000_privileged_roles.sql, with the developer
// given full access by 20260107000000_developer_full_access.sql):
//
//   members      INSERT  -> admin_roster_insert (is_admin(): president, vice-president, developer)
//   members      UPDATE  -> member_self_update  (own row, or is_admin())
//   members      DELETE  -> no policy at all: people cannot be deleted, ever
//   subteams     INSERT  -> department_insert   (can_manage_departments(): president, vice-president, developer)
//   subteams     UPDATE  -> department_update   (can_manage_departments()) — no DELETE policy: archive, never delete
//   milestones   ALL     -> admin_write         (is_admin())
//   seasons      INSERT/UPDATE/DELETE -> season_* (can_manage_seasons(): president or developer)
//   season switch        -> set_current_season() raises unless can_manage_seasons()
//   member_roles INSERT  -> role_assign         (can_grant_role(role): see PERMISSIONS.md §4)
//   member_roles DELETE  -> role_remove         (same, and never the last president)
//
// What to show comes from usePermissions() — this file never inspects roles to
// decide access. Editing it to un-hide a button gets you a rejected request,
// not access.

function Section({
  title,
  tutorialId,
  children,
}: {
  title: string
  // What the guided tour calls this section, if it points at it.
  tutorialId?: string
  children: ReactNode
}) {
  return (
    <section className="mt-6" aria-labelledby={`s-${title.replace(/\s+/g, '-')}`} data-tutorial={tutorialId}>
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

// Used once, for what the signed-in person cannot do on this page (shown only when there is something).
function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
      {children}
    </p>
  )
}

export default function Settings() {
  const { canAdminister, canManageRoles, canManageDepartments, canManageSeasons, roles: myRoles } = usePermissions()
  const restriction = canManageRoles && canManageSeasons
    ? null
    : canManageRoles
      ? 'You cannot change seasons or the President and Vice President roles; those belong to the President.'
      : canAdminister
        ? 'You cannot change roles; only the President can give or take them away.'
        : 'You cannot change the roster, departments, milestones or seasons; those are reserved for the President and Vice President. The database enforces this, so those forms are hidden rather than shown and refused.'

  return (
    <main id="main-content" tabIndex={-1} className={pageMain('reading')}>
      <PageHeader
        title="Settings"
        description="The roster, departments, milestone dates, handover notes and seasons."
        tutorialId="settings-overview"
      />

      {/* Only what this person CANNOT do here, in words — never left to be inferred from which buttons happen
          to be missing. What they can do is not listed: the forms are simply there. */}
      {restriction && <Notice>{restriction}</Notice>}

      <Section title="Your account" tutorialId="settings-account">
        <AccountSettings />
      </Section>

      <Section title="Roster" tutorialId="settings-roster">
        <RosterSettings />
      </Section>

      {canManageDepartments && (
        <Section title="Departments" tutorialId="settings-departments">
          <DepartmentSettings />
        </Section>
      )}

      {canAdminister && (
        <Section title="Milestone dates and points" tutorialId="settings-milestones">
          <MilestoneSettings />
        </Section>
      )}

      {canAdminister && (
        <Section title="Requirements Book">
          <BookSettings />
        </Section>
      )}

      {canAdminister && attachmentsEnabled() && (
        <Section title="File storage">
          <StorageUsage />
        </Section>
      )}

      {canAdminister && backupsEnabled() && (
        <Section title="Backups" tutorialId="settings-backups">
          <BackupsPanel />
          <div className="mt-3">
            <BackupsGuide defaultAudience={myRoles.includes('developer') ? 'developer' : 'leaders'} />
          </div>
        </Section>
      )}

      <Section title="Handover notes" tutorialId="settings-handover">
        <HandoverSettings />
      </Section>

      <Section title="Seasons" tutorialId="settings-seasons">
        <SeasonSettings canManageSeasons={canManageSeasons} />
      </Section>

      <Section title="Export" tutorialId="settings-export">
        <SeasonExport />
      </Section>
    </main>
  )
}
