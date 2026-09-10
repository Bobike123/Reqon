// The eight screens, in the order Prompt 0 gives them. This is the only place
// the main navigation is defined — add a screen here and it appears in the
// header on desktop and in the Menu on a phone.
export const NAV_ITEMS: { to: string; label: string; end?: boolean }[] = [
  { to: '/', label: 'Now', end: true },
  { to: '/priorities', label: 'Priorities' },
  { to: '/register', label: 'Register' },
  { to: '/milestones', label: 'Milestones' },
  { to: '/board', label: 'Board' },
  { to: '/meetings', label: 'Meetings' },
  { to: '/specs', label: 'Spec sheet' },
  { to: '/settings', label: 'Settings' },
]
