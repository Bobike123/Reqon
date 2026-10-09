// Every screen, grouped by how people use it: Now first; daily work; planning; the competition rules;
// records; admin last. This is the only place the main navigation is defined — add a
// screen here and it appears in the header on desktop and in the Menu on a
// phone.
//
// `requires` leaves a screen out of the menu for people who could see nothing
// on it. It is not security — the database decides what anyone may read — it
// just avoids a menu item that always leads to "nothing to show you here".
// `group` only draws a thin divider between neighbours that differ on a wide screen; it never hides anything.
export type NavGroup = 'home' | 'work' | 'plan' | 'rules' | 'records' | 'admin'
export type NavItem = { to: string; label: string; group: NavGroup; end?: boolean; requires?: 'canViewFinances' | 'attachmentsEnabled' }

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Now', group: 'home', end: true },
  { to: '/board', label: 'Board', group: 'work' },
  { to: '/priorities', label: 'Priorities', group: 'work' },
  { to: '/proposals', label: 'Proposals', group: 'work' },
  { to: '/meetings', label: 'Meetings', group: 'work' },
  { to: '/milestones', label: 'Milestones', group: 'plan' },
  { to: '/gantt', label: 'Gantt', group: 'plan' },
  { to: '/register', label: 'Register', group: 'rules' },
  { to: '/book', label: 'Book', group: 'rules' },
  { to: '/specs', label: 'Spec sheet', group: 'rules' },
  { to: '/files', label: 'Files', group: 'records', requires: 'attachmentsEnabled' },
  { to: '/archive', label: 'Archive', group: 'records' },
  { to: '/finances', label: 'Finances', group: 'admin', requires: 'canViewFinances' },
  { to: '/settings', label: 'Settings', group: 'admin' },
]
