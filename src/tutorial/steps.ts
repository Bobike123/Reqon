import type { Permissions } from '../auth/permissions.ts'

// What an audience check needs: the privileged-role permissions everyone
// already mirrors, plus whether this person heads at least one active
// department — resource-aware authority (ADR-0003) that does not come from
// any privileged role. Built once in TutorialProvider.tsx from
// usePermissions() and useTaskActor()'s `headOf`; a Head of several
// departments is still just `true` here, since no tour step is specific to
// one department.
export type TourViewer = Permissions & { isHeadOfDepartment: boolean }

export type Side = 'bottom' | 'top' | 'right' | 'left'

// The parts of the tour, in the order they run: one per screen, so someone who
// only wants to learn the Board can take just that part from the chooser.
export const CHAPTERS = [
  { id: 'start', label: 'Getting started' },
  { id: 'now', label: 'Now' },
  { id: 'priorities', label: 'Priorities' },
  { id: 'register', label: 'Register' },
  { id: 'book', label: 'Requirements Book' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'gantt', label: 'Gantt' },
  { id: 'board', label: 'Board' },
  { id: 'proposals', label: 'Task proposals' },
  { id: 'archive', label: 'Archive' },
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
    label: 'President, Vice President and Treasurer',
    includes: (can) => can.canViewFinances,
  },
  financeReadOnly: {
    label: 'President and Vice President',
    includes: (can) => can.canViewFinances && !can.canManageFinances,
  },
  treasurer: { label: 'Treasurer', includes: (can) => can.canManageFinances },
  admins: { label: 'President and Vice President', includes: (can) => can.canAdminister },
  // Seasons and the President / Vice President / Developer roles stay with the
  // President and a Developer (can_manage_seasons, can_grant_role).
  president: { label: 'President', includes: (can) => can.canManageSeasons },
  vicePresident: { label: 'Vice President', includes: (can) => can.canAdminister && !can.canManageSeasons },
  meetingEditors: {
    label: 'President, Vice President and Documentation',
    includes: (can) => can.canEditMeetingTemplate,
  },
  // Resource-aware, not role-aware (ADR-0003): true for anyone who heads at
  // least one active department, whether or not they also hold a privileged
  // role. A Head with no privileged role must still see these.
  head: { label: 'Head of a department', includes: (can) => can.isHeadOfDepartment },
  // Whoever may review proposals (can_review_proposal): the Head of the proposal's department, the
  // President or Vice President (every department since the role hierarchy, 20260130000000), or a Developer.
  proposalReviewer: {
    label: 'A department Head, the President or Vice President',
    includes: (can) => can.isHeadOfDepartment || can.hasRole('president') || can.hasRole('vicepresident') || can.hasRole('developer'),
  },
} satisfies Record<string, { label: string; includes: (can: TourViewer) => boolean }>

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
    body: 'Your name and, if you hold one, your role: President, Vice President, Treasurer or Documentation. Everyone else is a member. The tour adds the parts your role uses.',
  },

  // ----------------------------------------------------------------------- Now
  {
    id: 'now',
    chapter: 'now',
    route: '/',
    target: 'now-instruments',
    title: 'Now — today at a glance',
    body: 'Overdue and blocked work, your open tasks, open proposals and the next submission. Each tile opens its list, already filtered. “…” is still loading; “—” could not load — never zero.',
  },
  {
    id: 'now-requirements',
    chapter: 'now',
    route: '/',
    target: 'now-requirements',
    title: 'Requirements progress',
    body: 'Each Requirements Book chapter and subchapter: its team rules and how many that apply are compliant or verified. Not applicable is counted apart; “not imported” is never 0 %. Tasks never mark rules compliant.',
  },
  {
    id: 'now-actions',
    chapter: 'now',
    route: '/',
    target: 'now-actions',
    title: 'What to do next',
    body: 'Short lists of overdue, blocked and soon-due work, your tasks and your proposals, each with owner, department, date and a link to the card. Proposals are raised on the Proposals screen.',
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
    body: 'Group by department, kind of work, milestone, owner, status or book order. “Owner” is the one to use before a meeting.',
  },
  {
    id: 'register-row',
    chapter: 'register',
    route: '/register',
    target: 'register-row',
    title: 'One rule',
    body: 'The bold reference is what the book prints. Tap a label for its meaning: NC RISK scores zero, PENALTY costs points, SPORTING is a kind of rule. PARKED means Final Event work — not an archived department.',
  },
  {
    id: 'register-controls',
    chapter: 'register',
    route: '/register',
    target: 'register-row-controls',
    title: 'Recording progress',
    body: 'Set the status (Open, In progress, Compliant, Verified, Blocked or Not applicable) and an owner. Evidence saves when you click away. ☆ stars the rule and puts it on Priorities.',
  },

  {
    id: 'register-links',
    chapter: 'register',
    route: '/register',
    target: 'register-links',
    title: 'Linked work and the book',
    body: '“n / m linked tasks done” counts the Board tasks on a rule; “Assign existing tasks” links yours. Done tasks never make it compliant — you decide. “Open in Requirements Book” shows its page beside the list.',
  },

  // ---------------------------------------------------------------------- Book
  {
    id: 'book',
    chapter: 'book',
    route: '/book',
    target: 'book-header',
    title: 'The Requirements Book',
    body: 'This season’s regulations, drawn page by page. A rule’s link opens its recorded page, else the start; Previous, Next and the page box turn pages. “Open the PDF in a new tab” always works.',
  },

  // ---------------------------------------------------------------- Milestones
  {
    id: 'milestones',
    chapter: 'milestones',
    route: '/milestones',
    target: 'milestone-card',
    title: 'Milestones — the deliverables',
    body: 'Each submission with its window, points, work done, and the dates it was submitted and accepted — three separate facts. BLOCKING keeps the bike off the track. “TBC” means no published date.',
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
    body: 'Every submission as a bar across the months; today is the dashed line. The Legend button explains each shape. A bar fills as linked work is done; “TBC” means no date is published — none is guessed.',
  },
  {
    id: 'gantt-expand',
    chapter: 'gantt',
    route: '/gantt',
    target: 'gantt-chart',
    title: 'Three levels',
    body: 'Open a submission for its sections and its unsectioned work, and a section for its tasks. A task with a start and a deadline is a period; with only a deadline it is a dot. Undated tasks say so.',
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
    title: 'Linking work to a section',
    body: 'The Gantt never creates tasks. Adopt a Board task you own or head, drag it onto a section, or drag its bar to change dates — “Move to” and the date fields in its details do the same by keyboard. Unlink keeps it on the Board.',
  },

  // --------------------------------------------------------------------- Board
  {
    id: 'board',
    chapter: 'board',
    route: '/board',
    target: 'board-lanes',
    title: 'Board — the team’s tasks',
    body: 'Five lanes: To do, In progress, Blocked, Done and Cancelled. A red “Urgent” badge marks priority separately from the lane — a task can be Blocked and Urgent. Nothing is dragged, so it works the same on a phone in the workshop.',
  },
  {
    id: 'board-card',
    chapter: 'board',
    route: '/board',
    target: 'board-card',
    title: 'A task',
    body: 'Department, owner, deadline, milestone, requirements. Move it with the dropdown (if you may); Blocked asks why. Details hold the description, blocker, tasks it waits for, links and the editor.',
  },

  // ------------------------------------------------------------------ Meetings
  {
    id: 'proposals',
    chapter: 'proposals',
    route: '/proposals',
    target: 'proposal-raise',
    title: 'Task proposals — suggest work',
    body: 'Anything the club should take on. Open “Raise a proposal” and give its department, deadline, milestone and requirement so its Head can decide. A folded-away draft is kept.',
  },
  {
    id: 'proposal-flow',
    chapter: 'proposals',
    route: '/proposals',
    target: 'proposal-flow',
    title: 'How a proposal moves',
    body: 'Suggested, Under review (the Head may ask for changes), Approved, then Decided once it becomes a task or is rejected. Parked sets one aside without deleting it.',
  },
  {
    id: 'proposal-card',
    chapter: 'proposals',
    route: '/proposals',
    target: 'proposal-card',
    title: 'A proposal',
    body: 'Who suggested it, its department, deadline and milestone, and where it stands. Its department’s Head decides; the President and the Vice President can decide for any department.',
  },
  {
    id: 'proposal-decision',
    chapter: 'proposals',
    route: '/proposals',
    target: 'proposal-decision',
    audience: 'proposalReviewer',
    title: 'Reviewing a proposal',
    body: 'Review opens the discussion with the author. Ask for changes or Approve with a note, then make the task. Editing an approved proposal withdraws the approval. Its Head decides, and so can the President or Vice President.',
  },
  {
    id: 'proposal-promote',
    chapter: 'proposals',
    route: '/proposals',
    target: 'proposal-promote',
    audience: 'proposalReviewer',
    title: 'Promoting a proposal',
    body: 'Approve and create task puts it on the Board with the proposal\'s department, deadline, priority, milestone and requirements. A proposal is approved once, and the task remembers where it came from.',
  },

  {
    id: 'board-edit',
    chapter: 'board',
    route: '/board',
    target: 'board-card',
    title: 'Who can edit a task',
    body: 'Its owner, its department’s Head, the President or the Vice President. Only they reassign it; moving it to another department needs a reason. Nothing is deleted: a Done task archives itself after 24 hours.',
  },

  // ------------------------------------------------------------------- Archive
  {
    id: 'archive',
    chapter: 'archive',
    route: '/archive',
    target: 'archive-filters',
    title: 'Archive — finished and decided work',
    body: 'Archived tasks and proposals that were approved or rejected, a page at a time. Search by title and filter by department, owner and status. Everyone can read it; nothing is deleted here.',
  },
  {
    id: 'archive-list',
    chapter: 'archive',
    route: '/archive',
    target: 'archive-list',
    title: 'Where it came from',
    body: 'Each task links to the proposal it came from, and each approved proposal to its task. Its department Head, the President or the Vice President can restore a task; a finished one reopens.',
  },

  // ------------------------------------------------------------------ Meetings
  {
    id: 'meetings',
    chapter: 'meetings',
    route: '/meetings',
    target: 'meeting-list',
    title: 'Meetings — what was decided',
    body: 'Every club meeting with its date, place, agenda and minutes, formatted as headings and lists. Everyone reads these; the board writes them. Proposals have their own screen.',
  },
  {
    id: 'meeting-new',
    chapter: 'meetings',
    route: '/meetings',
    target: 'meeting-new',
    audience: 'admins',
    title: 'Calling a meeting',
    body: 'A name and a date are required; the rest is optional. The agenda starts from the default agenda and can change for this meeting only. Preview shows how it will read.',
  },
  {
    id: 'meeting-template',
    chapter: 'meetings',
    route: '/meetings',
    target: 'meeting-template',
    audience: 'meetingEditors',
    title: 'The default agenda',
    body: 'Every new meeting starts from this. “Edit default agenda” opens it in a dialog; unsaved text is kept if you close it. Existing meetings never change. The President, Vice President and Documentation edit it.',
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
    body: 'Our value against the goal and the rule’s limit: Review, then Save measurement. Nobody types pass or fail by hand. Green needs someone to confirm the current value ready; competition results have their own column.',
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
    body: 'You can see every entry, but only the Treasurer can add, edit or delete one. If something looks wrong, tell the Treasurer.',
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
    title: 'Which roles you manage',
    body: 'As Vice President you give or take away the Treasurer and Documentation roles. President and Vice President roles, and switching seasons, belong to the President.',
  },
  {
    id: 'change-roles',
    chapter: 'settings',
    route: '/settings',
    target: 'change-roles',
    audience: 'president',
    title: 'Giving and taking away roles',
    body: 'The President manages the President and Vice President roles; the Vice President manages Treasurer and Documentation. “Change roles” opens a checklist; big changes ask you to confirm first.',
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
    body: 'Give President to your successor and tick the hand-over box: their role is saved first and yours is removed last. From then on the presidency, and season changes, are theirs.',
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
    body: 'Type their name, email and a first password, then Add to roster. That creates their login and adds them in one step, with no privileged role; they change the password in Settings → Your account.',
  },
  {
    id: 'settings-departments',
    chapter: 'settings',
    route: '/settings',
    target: 'settings-departments',
    audience: 'admins',
    title: 'Departments',
    body: 'Choose Edit on a department to rename or describe it, appoint its Head or park it, then Save. Reorder, create, or archive one — up to 10 active. Archiving never deletes; restore it from Archived.',
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
    body: 'One note per department, for whoever takes it over next year. Anyone can write here, and a note saves when you click away.',
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
    body: 'Create it here (it can copy this season’s milestones and sections, without dates), then press “Make current” when ready. Tasks, progress and finances start empty; nothing switches until you say so.',
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
