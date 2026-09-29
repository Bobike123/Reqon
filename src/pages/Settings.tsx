import type { ReactNode } from 'react'
import { PageHeader } from '../ui/PageHeader.tsx'
import { describeRoles } from '../auth/permissions.ts'
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
//   seasons      ALL     -> admin_write         (is_admin())
//   season switch        -> set_current_season() raises unless is_admin()
//   member_roles INSERT  -> role_assign         (can_manage_roles(): president or developer)
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

// Used once, for what the signed-in person can do on this page.
function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700" data-tutorial="settings-access">
      {children}
    </p>
  )
}

export default function Settings() {
  const { canAdminister, canManageRoles, canManageDepartments, roles: myRoles } = usePermissions()

  return (
    <main id="main-content" tabIndex={-1} className={pageMain('reading')}>
      <PageHeader
        title="Settings"
        description="The roster, departments, milestone dates, handover notes and seasons."
        tutorialId="settings-overview"
      />

      {/* What this person can do here, in words — never left to be inferred
          from which buttons happen to be missing. */}
      <Notice>
        Signed in as <strong className="font-medium text-slate-900">{describeRoles(myRoles)}</strong>.{' '}
        {canManageRoles
          ? 'You can change everything on this page, including who holds which role.'
          : canAdminister
            ? 'You can change everything on this page except roles, which only the President or a Developer can give or take away.'
            : 'Roster, department, milestone and season changes are reserved for the President, Vice President and Developer — the database enforces this, so those forms are hidden rather than shown and refused. Handover notes below are open to everyone.'}
      </Notice>

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

      <Section title="Handover notes" tutorialId="settings-handover">
        <HandoverSettings />
      </Section>

      <Section title="Seasons" tutorialId="settings-seasons">
        <SeasonSettings canAdminister={canAdminister} />
      </Section>

      <Section title="Export" tutorialId="settings-export">
        <SeasonExport />
      </Section>
    </main>
  )
}
