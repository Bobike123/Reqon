import type { Permissions } from '../auth/permissions.ts'

export type Side = 'bottom' | 'top' | 'right' | 'left'

// The parts of the tour, in the order they run: one per screen, so someone who
// only wants to learn the Board can take just that part from the chooser.
export const CHAPTERS = [
  { id: 'start', label: 'Getting started' },
  { id: 'now', label: 'Now' },
  { id: 'priorities', label: 'Priorities' },
  { id: 'register', label: 'Register' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'gantt', label: 'Gantt' },
  { id: 'board', label: 'Board' },
  { id: 'proposals', label: 'Task proposals' },
  { id: 'meetings', label: 'Meetings' },
  { id: 'specs', label: 'Spec sheet' },
  { id: 'finances', label: 'Finances' },
  { id: 'settings', label: 'Settings and your account' },
  // The closing step. Ends the full tour and the role tour; never offered alone.
  { id: 'end', label: 'Wrapping up' },
] as const

export type ChapterId = (typeof CHAPTERS)[number]['id']

// Who a step is for, decided from the same permissions the screens use to
// decide what to show — so the tour never explains a control the person
// watching it does not have. `label` is shown on the step ("Only for: …").
export const AUDIENCES = {
  finance: {
    label: 'President, Vice President, Treasurer and Developer',
    includes: (can) => can.canViewFinances,
  },
  financeReadOnly: {
    label: 'President and Vice President',
    includes: (can) => can.canViewFinances && !can.canManageFinances,
  },
  treasurer: { label: 'Treasurer and Developer', includes: (can) => can.canManageFinances },
  admins: { label: 'President, Vice President and Developer', includes: (can) => can.canAdminister },
  president: { label: 'President and Developer', includes: (can) => can.canManageRoles },
  vicePresident: { label: 'Vice President', includes: (can) => can.canAdminister && !can.canManageRoles },
  // The Developer holds every power in the club, so this is the one audience
  // that asks which role someone holds rather than what they may do.
  developer: { label: 'Developer', includes: (can) => can.hasRole('developer') },
} satisfies Record<string, { label: string; includes: (can: Permissions) => boolean }>

export type Audience = keyof typeof AUDIENCES

export type TutorialStep = {
  id: string
  chapter: ChapterId
  // Screen to open for this step. Omit to stay on whatever is showing.
  route?: string
  // The value of a data-tutorial="…" attribute on the REAL element to
  // highlight. Never a generated class name or a DOM path: restyling a screen
  // must not silently break the tour. tutorial.test.tsx fails if a step points
  // at an attribute no screen renders. Omit for a step about the app as a
  // whole: its card sits in the middle of the screen.
  target?: string
  title: string
  body: string
  placement?: Side
  // Omit for everyone on the roster.
  audience?: Audience
}

// The guided tour. It walks through the real app and points at real controls;
// it never clicks anything or changes any data. Members see the steps with no
// audience; each role also sees its own, in place on the screen they belong to.
export const TUTORIAL_STEPS: TutorialStep[] = [
  // ------------------------------------------------------------ Getting started
  {
    id: 'welcome',
    chapter: 'start',
    route: '/',
    title: 'Welcome to Reqon',
    body: 'The team’s shared record for the MotoStudent season: every rule, task, meeting and measurement in one place. This tour points at the real screens. It never clicks anything or changes data.',
  },
  {
    id: 'navigation',
    chapter: 'start',
    route: '/',
    target: 'main-nav',
    title: 'Getting around',
    body: 'Each screen has one job. The one you are on is filled in, and the tour visits them left to right. On a phone they all sit under Menu.',
  },
  {
    id: 'season',
    chapter: 'start',
    route: '/',
    target: 'season-badge',
    title: 'The current season',
    body: 'Everything on screen belongs to this season. When the club moves to a new one, the screens start fresh and this season’s work stays in the database.',
  },
  {
    id: 'account',
    chapter: 'start',
    route: '/',
    target: 'account-roles',
    title: 'You, and your role',
    body: 'Your name and, if you hold one, your role: President, Vice President, Treasurer or Developer. Everyone else is a member. The tour adds the parts your role uses.',
  },

  // ----------------------------------------------------------------------- Now
  {
    id: 'now',
    chapter: 'now',
    route: '/',
    target: 'now-instruments',
    title: 'Now — today at a glance',
    body: 'The next deadline, how many obligations are resolved, and what is overdue, blocked or waiting for a meeting. Click any tile to open the screen behind the number.',
  },
  {
    id: 'now-subsystems',
    chapter: 'now',
    route: '/',
    target: 'now-subsystems',
    title: 'Progress by subsystem',
    body: 'How many of each subsystem’s duties are resolved, and how many are blocked. Click a row to open the Register already filtered to that subsystem.',
  },
  {
    id: 'now-proposals',
    chapter: 'now',
    route: '/',
    target: 'now-proposals',
    title: 'Proposals, right from Now',
    body: 'Suggested, under-review and decided proposals show here too, so you can suggest one without leaving Now. It is the same list as the Proposals screen.',
  },

  // ---------------------------------------------------------------- Priorities
  {
    id: 'priorities',
    chapter: 'priorities',
    route: '/priorities',
    target: 'priorities-list',
    title: 'Priorities — what bites first',
    body: 'Blocked rules, score-killers, overdue tasks, penalty risks and anything starred, most urgent first. The database builds this list, so everyone sees the same one.',
  },
  {
    id: 'priority-row',
    chapter: 'priorities',
    route: '/priorities',
    target: 'priority-row',
    title: 'One item',
    body: 'The coloured label says why it is here. Click the rule’s reference to open it in the Register, or “Open on Board” for a task, and give it an owner with the dropdown.',
  },

  // ------------------------------------------------------------------ Register
  {
    id: 'register',
    chapter: 'register',
    route: '/register',
    target: 'register-live',
    title: 'Register — every rule',
    body: 'Every rule in the regulations, and what the team has done about each. The count shows how many match your filters; “live updates” means other people’s changes appear without reloading.',
  },
  {
    id: 'register-filters',
    chapter: 'register',
    route: '/register',
    target: 'register-filters',
    title: 'Finding a rule',
    body: 'Search by reference or wording, or narrow by kind of work and owner. “Team duties only” is on by default: it hides definitions and the Organization’s own powers — rules that ask nothing of the team.',
  },
  {
    id: 'register-grouping',
    chapter: 'register',
    route: '/register',
    target: 'register-grouping',
    title: 'The same rules, re-filed',
    body: 'Group by subsystem, kind of work, milestone, owner, status or book order. “Owner” is the one to use before a meeting.',
  },
  {
    id: 'register-row',
    chapter: 'register',
    route: '/register',
    target: 'register-row',
    title: 'One rule',
    body: 'The bold reference is what the book prints. Red NC RISK means breaking it scores zero; amber PENALTY means points lost. Dimmed rules are parked until the Final Event.',
  },
  {
    id: 'register-controls',
    chapter: 'register',
    route: '/register',
    target: 'register-row-controls',
    title: 'Recording progress',
    body: 'Set the status (Open, In progress, Compliant, Verified, Blocked or Not applicable) and an owner. Evidence saves when you click away. ☆ stars the rule and puts it on Priorities.',
  },

  // ---------------------------------------------------------------- Milestones
  {
    id: 'milestones',
    chapter: 'milestones',
    route: '/milestones',
    target: 'milestone-card',
    title: 'Milestones — the deliverables',
    body: 'Each submission with its window, days left and points. BLOCKING means missing it keeps the bike off the track. “TBC” means no date has been published — never a guess.',
  },
  {
    id: 'milestone-sections',
    chapter: 'milestones',
    route: '/milestones',
    target: 'milestone-sections',
    title: 'Section checklists',
    body: 'Tick a section once its draft exists. The count updates for everyone, so the whole team can see how close each submission is.',
  },
  {
    id: 'milestone-format',
    chapter: 'milestones',
    route: '/milestones',
    target: 'milestone-format',
    title: 'The format rules',
    body: 'How deliverables must be formatted and what mistakes cost, taken straight from the regulations text. If it disagrees with something you were told, the book wins.',
  },

  // --------------------------------------------------------------------- Gantt
  {
    id: 'gantt',
    chapter: 'gantt',
    route: '/gantt',
    target: 'gantt-chart',
    title: 'Gantt — the season on one timeline',
    body: 'Every submission as a bar across the months, with today marked in red. A bar fills from the left as the work under it is finished. “TBC” means no window has been published.',
  },
  {
    id: 'gantt-expand',
    chapter: 'gantt',
    route: '/gantt',
    target: 'gantt-chart',
    title: 'Three levels',
    body: 'Open a submission to see its sections, and a section to see its subtasks. A section with no dated subtasks borrows the submission’s window rather than inventing one.',
  },
  {
    id: 'gantt-tasks',
    chapter: 'gantt',
    route: '/gantt',
    target: 'gantt-chart',
    title: 'Subtasks are Board tasks',
    body: 'The subtasks here are the real cards from the Board, not copies. Change a status or an owner in either place and the other agrees, because there is only one task.',
  },
  {
    id: 'gantt-add',
    chapter: 'gantt',
    route: '/gantt',
    target: 'gantt-chart',
    audience: 'admins',
    title: 'Adding work to a section',
    body: '“Add to Board” creates an ordinary task already linked to that section, and the dropdown beside it adopts a task the Board already has. Unlink leaves the task on the Board.',
  },

  // --------------------------------------------------------------------- Board
  {
    id: 'board',
    chapter: 'board',
    route: '/board',
    target: 'board-lanes',
    title: 'Board — the team’s tasks',
    body: 'Six lanes: Urgent, To do, In progress, Blocked, Done and Cancelled. On a wide screen they sit side by side. Nothing is dragged, so it works the same on a phone in the workshop.',
  },
  {
    id: 'board-card',
    chapter: 'board',
    route: '/board',
    target: 'board-card',
    title: 'A task',
    body: 'Move a task with its first dropdown and give it an owner with the second. A red due date means overdue. “From proposal” names the meeting proposal it came from.',
  },

  // ------------------------------------------------------------------ Meetings
  {
    id: 'proposals',
    chapter: 'proposals',
    route: '/proposals',
    target: 'proposal-raise',
    title: 'Task proposals — suggest work',
    body: 'Anything you think the club should take on. A short title is enough; add context if it helps. Anyone on the roster can suggest, here or on Now.',
  },
  {
    id: 'proposal-flow',
    chapter: 'proposals',
    route: '/proposals',
    target: 'proposal-flow',
    title: 'How a proposal moves',
    body: 'Suggested, then Under review, then Decided, with how many proposals sit at each stage. Parked sets one aside without deleting it.',
  },
  {
    id: 'proposal-card',
    chapter: 'proposals',
    route: '/proposals',
    target: 'proposal-card',
    title: 'A proposal',
    body: 'Who suggested it, when, and where it stands. As a member you read it here and watch the stage change; the board does the deciding.',
  },
  {
    id: 'proposal-decision',
    chapter: 'proposals',
    route: '/proposals',
    target: 'proposal-decision',
    audience: 'admins',
    title: 'Recording the decision',
    body: 'The stage, the owner and the club’s answer. It saves when you click away and stays editable at every stage, so a decision can be corrected later.',
  },
  {
    id: 'proposal-promote',
    chapter: 'proposals',
    route: '/proposals',
    target: 'proposal-promote',
    audience: 'admins',
    title: 'Promoting a proposal',
    body: '“Promote to task” asks for an owner, a due date and a starting lane, then puts it on the Board. A proposal promotes once, and the task remembers where it came from.',
  },

  {
    id: 'board-delete',
    chapter: 'board',
    route: '/board',
    target: 'board-card',
    audience: 'president',
    title: 'Deleting a task',
    body: 'Only you and a Developer can delete a task, and the confirmation names the one that will go. A deleted task takes its history with it; the proposal it came from stays.',
  },

  // ------------------------------------------------------------------ Meetings
  {
    id: 'meetings',
    chapter: 'meetings',
    route: '/meetings',
    target: 'meeting-list',
    title: 'Meetings — what was decided',
    body: 'Every club meeting with its date, place, agenda and minutes. Everyone reads these; the board writes them. This screen used to show proposals, which now have their own.',
  },
  {
    id: 'meeting-new',
    chapter: 'meetings',
    route: '/meetings',
    target: 'meeting-new',
    audience: 'admins',
    title: 'Calling a meeting',
    body: 'A name and a date are required; time, place, agenda and minutes are not. The agenda starts from the club’s template, and you can change it for this meeting only.',
  },
  {
    id: 'meeting-template',
    chapter: 'meetings',
    route: '/meetings',
    target: 'meeting-template',
    audience: 'president',
    title: 'The default agenda',
    body: 'Every new meeting starts from this text. Editing it changes nothing about meetings that already exist, and only you and a Developer can change it.',
  },

  // ---------------------------------------------------------------- Spec sheet
  {
    id: 'spec-summary',
    chapter: 'specs',
    route: '/specs',
    target: 'spec-summary',
    title: 'Spec sheet — measurements',
    body: 'How many of the rules’ measurable limits have been measured, and how many fail. A failing value always links to the rule it breaks.',
  },
  {
    id: 'spec-row',
    chapter: 'specs',
    route: '/specs',
    target: 'spec-row',
    title: 'Entering a measurement',
    body: 'Type the measured value and the verdict comes from the rule’s own limit. Nobody types pass or fail by hand, and an empty box means “not measured”, never a pass.',
  },

  // ------------------------------------------------------------------ Finances
  {
    id: 'finance-access',
    chapter: 'finances',
    route: '/finances',
    target: 'finance-access',
    audience: 'finance',
    title: 'Finances — the club’s money',
    body: 'Income and expenses for the current season. This line says what you may do here. Ordinary members have no Finances screen at all.',
  },
  {
    id: 'finance-totals',
    chapter: 'finances',
    route: '/finances',
    target: 'finance-totals',
    audience: 'finance',
    title: 'Totals',
    body: 'Income, expenses and the balance, worked out from the entries below. A red balance means the season has spent more than it has taken in.',
  },
  {
    id: 'finance-read-only',
    chapter: 'finances',
    route: '/finances',
    target: 'finance-entries',
    audience: 'financeReadOnly',
    title: 'Read-only for you',
    body: 'You can see every entry, but only the Treasurer and the Developer can add, edit or delete one — the database refuses changes from anyone else. If something looks wrong, tell the Treasurer.',
  },
  {
    id: 'finance-add',
    chapter: 'finances',
    route: '/finances',
    target: 'finance-add',
    audience: 'treasurer',
    title: 'Adding an entry',
    body: 'Pick income or expense, then the date, the amount in euros (up to two decimals), a description and an optional category. Categories you have used before are suggested.',
  },
  {
    id: 'finance-edit',
    chapter: 'finances',
    route: '/finances',
    target: 'finance-entries',
    audience: 'treasurer',
    title: 'Correcting an entry',
    body: 'Each entry has Edit and Delete. Deleting asks you to confirm and cannot be undone. The database records who created each entry and accepts these changes only from you.',
  },
  {
    id: 'finance-handover',
    chapter: 'finances',
    route: '/finances',
    target: 'finance-access',
    audience: 'treasurer',
    title: 'Seasons and handing over',
    body: 'Entries belong to the current season, and a new season starts with an empty ledger. When you step down, the President gives the role to the next Treasurer and your editing stops at once.',
  },

  // ------------------------------------------------------------------ Settings
  {
    id: 'settings-access',
    chapter: 'settings',
    route: '/settings',
    target: 'settings-access',
    title: 'Settings — what you can do here',
    body: 'This line says what your role allows on this page. Everyone can change their password, write handover notes and download the season; the rest is for the President and Vice President.',
  },
  {
    id: 'developer-scope',
    chapter: 'settings',
    route: '/settings',
    target: 'settings-access',
    audience: 'developer',
    title: 'What a Developer can do',
    body: 'Everything: roles, the roster, the rulebook, seasons and the money. The role exists so the app can be maintained and repaired, so nothing on screen will stop you — be careful, and hand it back when you are done.',
  },
  {
    id: 'settings-account',
    chapter: 'settings',
    route: '/settings',
    target: 'settings-account',
    title: 'Your password',
    body: 'Type your current password, then the new one twice. Every other device you are signed in on is signed out; this one stays signed in.',
  },
  {
    id: 'settings-roster',
    chapter: 'settings',
    route: '/settings',
    target: 'settings-roster',
    title: 'The roster',
    body: 'Everyone on the team, with their job title and any role badges. People are retired as alumni, never deleted, so their name stays on the work they did.',
  },
  {
    id: 'vp-roles',
    chapter: 'settings',
    route: '/settings',
    target: 'settings-roster',
    audience: 'vicePresident',
    title: 'Roles are the President’s',
    body: 'As Vice President you can change everything in Settings except roles. If someone needs a role given or taken away, ask the President or a Developer.',
  },
  {
    id: 'change-roles',
    chapter: 'settings',
    route: '/settings',
    target: 'change-roles',
    audience: 'president',
    title: 'Giving and taking away roles',
    body: 'The President and any Developer can. “Change roles” opens a checklist for that person. Vice President changes save at once; President, Treasurer and Developer changes ask you to confirm first.',
  },
  {
    id: 'role-rules',
    chapter: 'settings',
    route: '/settings',
    target: 'change-roles',
    audience: 'president',
    title: 'Rules that protect the club',
    body: 'The last President can never be removed — the database refuses it too. Giving Treasurer to someone new asks whether to replace the current Treasurer or keep both.',
  },
  {
    id: 'role-hand-over',
    chapter: 'settings',
    route: '/settings',
    target: 'change-roles',
    audience: 'president',
    title: 'Handing over the presidency',
    body: 'Give President to your successor and tick the hand-over box: their role is saved first and yours is removed last. From then on, only they can change roles.',
  },
  {
    id: 'roster-controls',
    chapter: 'settings',
    route: '/settings',
    target: 'roster-controls',
    audience: 'admins',
    title: 'Keeping the roster up to date',
    body: 'Edit a job title, or mark someone Alumni when they leave. Alumni is only a label: to stop them signing in, also remove their login in the Supabase dashboard.',
  },
  {
    id: 'add-member',
    chapter: 'settings',
    route: '/settings',
    target: 'add-member',
    audience: 'admins',
    title: 'Adding a new member',
    body: 'First create their login in the Supabase dashboard (Authentication → Users), then paste its UUID here with their name. The app can’t create logins: that needs a secret key.',
  },
  {
    id: 'settings-subsystems',
    chapter: 'settings',
    route: '/settings',
    target: 'settings-subsystems',
    audience: 'admins',
    title: 'Subsystems',
    body: 'Rename a subsystem, choose its lead and describe what it covers. Each change saves when you click away or pick from the list.',
  },
  {
    id: 'settings-milestones',
    chapter: 'settings',
    route: '/settings',
    target: 'settings-milestones',
    audience: 'admins',
    title: 'Milestone dates and points',
    body: 'When the organisers publish dates, enter them here. Leave a date blank and it shows as TBC everywhere, never a guess.',
  },
  {
    id: 'settings-handover',
    chapter: 'settings',
    route: '/settings',
    target: 'settings-handover',
    title: 'Handover notes',
    body: 'One note per subsystem, for whoever takes it over next year. Anyone can write here, and a note saves when you click away.',
  },
  {
    id: 'settings-seasons',
    chapter: 'settings',
    route: '/settings',
    target: 'settings-seasons',
    title: 'Seasons',
    body: 'The current season is marked. The club always has exactly one, and older seasons stay readable.',
  },
  {
    id: 'new-season',
    chapter: 'settings',
    route: '/settings',
    target: 'new-season',
    audience: 'admins',
    title: 'Starting a new season',
    body: 'Create it here, then press “Make current” when the team is ready. The rulebook carries over; progress, tasks and finances start empty, and nothing switches until you say so.',
  },
  {
    id: 'settings-export',
    chapter: 'settings',
    route: '/settings',
    target: 'settings-export',
    title: 'Export',
    body: 'Download everything in this season as one file, for a backup or a handover. It contains no passwords, emails or keys.',
  },

  // ---------------------------------------------------------------------- End
  {
    id: 'finish',
    chapter: 'end',
    target: 'help-button',
    title: 'That’s the tour',
    body: 'Start it again, or just one screen of it, from Tutorial — here, or under Menu on a phone. Everything you saw was real data, and nothing was changed.',
  },
]
