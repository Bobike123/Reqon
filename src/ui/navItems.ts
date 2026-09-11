// Every screen, in the order Prompt 0 gives them, with Finances before
// Settings. This is the only place the main navigation is defined — add a
// screen here and it appears in the header on desktop and in the Menu on a
// phone.
//
// `requires` leaves a screen out of the menu for people who could see nothing
// on it. It is not security — the database decides what anyone may read — it
// just avoids a menu item that always leads to "nothing to show you here".
export type NavItem = { to: string; label: string; end?: boolean; requires?: 'canViewFinances' }

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Now', end: true },
  { to: '/priorities', label: 'Priorities' },
  { to: '/register', label: 'Register' },
  { to: '/milestones', label: 'Milestones' },
  { to: '/board', label: 'Board' },
  { to: '/meetings', label: 'Meetings' },
  { to: '/specs', label: 'Spec sheet' },
  { to: '/finances', label: 'Finances', requires: 'canViewFinances' },
  { to: '/settings', label: 'Settings' },
]
