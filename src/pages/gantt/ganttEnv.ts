import type { Member } from '../../data/useMembers.ts'
import type { Task, TaskState } from '../../data/useTasks.ts'
import type { GanttTaskPerms } from './GanttTaskRow.tsx'
import type { LinkTarget } from './ganttLinking.ts'
import type { Span } from './ganttModel.ts'
import type { TaskRef } from '../../tasks/dependencies.ts'

// Everything the row levels (milestone, section, unsectioned group, task) share,
// passed down as one object so each level's own props stay about that level.
// Read-only facts first, then the handlers. Nothing here creates a task: the only
// work-association handlers are link, unlink-section and unlink-milestone.
export type GanttEnv = {
  // The reader's own calendar day (lib/dates.ts todayIso), passed in so every
  // row, and every screen, judges "late" against the same day.
  today: string
  range: Span
  todayLeft: number | null
  seasonId: string
  members: Member[]
  memberNames: ReadonlyMap<string, string>
  departmentNames: ReadonlyMap<string, string>
  sectionNames: ReadonlyMap<string, string>

  // Presentation-only mirrors of the database's rules (auth/permissions.ts).
  permsFor: (task: Task) => GanttTaskPerms

  // The department lens. `matches` says whether a task passes it; `name` names it
  // for text ("Aerodynamics", "My tasks"). Inactive means everything passes.
  lens: { active: boolean; name: string; matches: (task: Pick<Task, 'owner_id' | 'subteam_key'>) => boolean }

  // Every place a task may be moved to on this timeline (each section, and each
  // submission's unsectioned group), for the keyboard/touch "Move to" select —
  // the same moves drag and drop offers.
  moveTargets: { key: string; label: string; target: LinkTarget }[]
  // A drop, or a "Move to" choice. Gantt.tsx decides whether it is a direct link
  // or a confirmed relink to another submission; the database re-checks either.
  onMoveTo: (task: Task, target: LinkTarget) => void
  // A schedule change from a dragged bar or the row's date fields. Resolves with
  // what was saved, or rejects with the database's refusal.
  onSchedule: (task: Task, start: string | null, due: string | null) => Promise<string>
  // Which task row is expanded (kept in the address as ?task=).
  expandedTask: string | null
  onToggleTask: (taskId: string) => void

  // What a task waits for (prerequisite tasks, any department), for the blocker
  // line and the schedule-conflict cue. Managed on the Board card.
  prerequisitesFor: (task: Task) => TaskRef[]
  onMove: (taskId: string, state: TaskState, blockedReason?: string) => void
  onOwner: (taskId: string, ownerId: string | null) => void
  onLink: (task: Task, target: LinkTarget) => void
  onUnlinkSection: (task: Task) => void
  onUnlinkMilestone: (task: Task) => void
}
