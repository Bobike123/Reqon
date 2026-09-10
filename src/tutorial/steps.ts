export type Side = 'bottom' | 'top' | 'right' | 'left'

export type TutorialStep = {
  id: string
  // Screen to open for this step. Omit to stay on whatever is showing.
  route?: string
  // The value of a data-tutorial="…" attribute on the REAL element to
  // highlight. Never a generated class name or a DOM path: restyling a screen
  // must not silently break the tour. tutorial.test.tsx fails if a step points
  // at an attribute no screen renders.
  target: string
  title: string
  body: string
  placement?: Side
}

// The guided tour. It walks through the real app and points at real controls;
// it never clicks anything or changes any data.
export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'navigation',
    route: '/',
    target: 'main-nav',
    title: 'Getting around',
    body: 'These are the eight screens. The one you are on is highlighted. On a phone they sit under Menu.',
  },
  {
    id: 'now',
    route: '/',
    target: 'now-instruments',
    title: 'Now — today at a glance',
    body: 'The next deadline, how many obligations are resolved, and what is overdue, blocked or waiting for a meeting. Click any tile to open the screen behind the number.',
  },
  {
    id: 'priorities',
    route: '/priorities',
    target: 'priorities-list',
    title: 'Priorities — what bites first',
    body: 'Blocked rules, score-killers, overdue tasks, penalty risks and anything starred, most urgent first. Give each an owner with the dropdown on its row.',
  },
  {
    id: 'register-filters',
    route: '/register',
    target: 'register-filters',
    title: 'Register — every rule',
    body: 'Search by reference or wording, or narrow by kind of work and owner. “Team duties only” is on by default: it hides definitions and the Organization’s own powers — rules that ask nothing of the team.',
  },
  {
    id: 'register-grouping',
    route: '/register',
    target: 'register-grouping',
    title: 'The same rules, re-filed',
    body: 'Group by subsystem, kind of work, milestone, owner, status or book order. “Owner” is the one to use before a meeting.',
  },
  {
    id: 'register-row',
    route: '/register',
    target: 'register-row',
    title: 'One rule',
    body: 'The bold reference is what the book prints. Set its status and owner, note the evidence, and star it to send it to Priorities. Red NC RISK means breaking it scores zero; amber PENALTY means points lost.',
  },
  {
    id: 'milestones',
    route: '/milestones',
    target: 'milestone-card',
    title: 'Milestones — the deliverables',
    body: 'Each submission with its window, days left and points. Tick sections off as they are drafted. “TBC” means no date has been published — never a guess.',
  },
  {
    id: 'board',
    route: '/board',
    target: 'board-lanes',
    title: 'Board — the team’s tasks',
    body: 'Six lanes, from Urgent to Cancelled. Move a task with the dropdown on its card — no dragging, so it works on a phone in the workshop.',
  },
  {
    id: 'meetings',
    route: '/meetings',
    target: 'topics-panel',
    title: 'Meetings — from topic to decision',
    body: 'Raise a topic, put it on the agenda, write down the decision, then press “Convert to task” to put it on the Board. Topics can be edited from Now too.',
  },
  {
    id: 'spec-sheet',
    route: '/specs',
    target: 'spec-row',
    title: 'Spec sheet — measurements',
    body: 'Type the measured value and the verdict comes from the rule’s own limit. Nobody types pass or fail by hand, and an empty box means “not measured”, never a pass.',
  },
  {
    id: 'settings',
    route: '/settings',
    target: 'settings-overview',
    title: 'Settings',
    body: 'The roster, subsystems, milestone dates, handover notes for next year’s team, and starting a new season. Some of it is for board members only.',
  },
  {
    id: 'finish',
    target: 'help-button',
    title: 'That’s the tour',
    body: 'Start it again any time from Tutorial — here, or under Menu on a phone. Everything you saw was real data, and nothing was changed.',
  },
]
