import type { Json } from '../lib/database.types.ts'
import { formatDay, formatInstant } from '../lib/dates.ts'
import type { ActivityRow } from './types.ts'

type Detail = Record<string, Json | undefined>

function detail(row: ActivityRow): Detail {
  return row.detail && typeof row.detail === 'object' && !Array.isArray(row.detail)
    ? row.detail as Detail
    : {}
}

function text(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function named(value: Json | undefined, names: ReadonlyMap<string, string>): string {
  const id = text(value)
  return id ? (names.get(id) ?? 'Someone no longer on the roster') : 'Unassigned'
}

function day(value: Json | undefined): string {
  const iso = text(value)
  return iso ? (formatDay(iso) || iso) : 'none'
}

function instant(value: Json | undefined): string {
  const iso = text(value)
  return iso ? (formatInstant(iso) || iso) : 'none'
}

function fromTo(d: Detail, render: (value: Json | undefined) => string = (value) => text(value) ?? 'none'): string {
  return `${render(d.from)} → ${render(d.to)}`
}

export type PresentedActivity = {
  icon: string
  summary: string
  reason: string | null
  taskId: string | null
  proposalId: string | null
}

export function actorLabel(row: ActivityRow, names: ReadonlyMap<string, string>): string {
  if (row.actor_id) return names.get(row.actor_id) ?? 'Former team member'
  return text(detail(row).actor_kind) === 'system' ? 'Automatic archive scheduler' : 'System or legacy process'
}

export function presentActivity(row: ActivityRow, names: ReadonlyMap<string, string>): PresentedActivity {
  const d = detail(row)
  const reason = text(d.reason)
  const base = { reason, taskId: text(d.task_id), proposalId: text(d.proposal_id) }
  switch (row.action) {
    case 'state_changed':
      return { ...base, icon: text(d.to) === 'blocked' ? '!' : '↔', summary: `State: ${fromTo(d)}` }
    case 'owner_changed':
      return { ...base, icon: '♙', summary: `Owner: ${fromTo(d, (value) => named(value, names))}` }
    case 'department_transferred':
    case 'department_changed':
      return { ...base, icon: '↔', summary: `Department: ${fromTo(d)}` }
    case 'priority_changed':
      return { ...base, icon: '!', summary: `Priority: ${fromTo(d)}` }
    case 'deadline_changed':
      return { ...base, icon: '◷', summary: `Deadline: ${fromTo(d, day)}` }
    case 'starts_on_changed':
      return { ...base, icon: '◷', summary: `Start date: ${fromTo(d, day)}` }
    case 'completed':
      return { ...base, icon: '✓', summary: `Completed${text(d.to) ? ` at ${instant(d.to)}` : ''}` }
    case 'completion_cleared':
      return { ...base, icon: '↺', summary: 'Completion cleared when work was reopened' }
    case 'archived':
      return { ...base, icon: '▣', summary: reason === 'auto_done_24h' ? 'Archived automatically after 24 hours Done' : 'Archived' }
    case 'restored':
    case 'reopened':
      return { ...base, icon: '↺', summary: row.action === 'restored' ? 'Restored to active work' : 'Proposal reopened' }
    case 'milestone_changed':
      return { ...base, icon: '◆', summary: `Milestone: ${fromTo(d)}` }
    case 'section_linked':
      return { ...base, icon: '◇', summary: `Linked to section ${text(d.to) ?? 'unknown'}` }
    case 'section_unlinked':
      return { ...base, icon: '◇', summary: `Unlinked from section ${text(d.from) ?? 'unknown'}` }
    case 'section_changed':
      return { ...base, icon: '◇', summary: `Section: ${fromTo(d)}` }
    case 'requirement_linked':
      return { ...base, icon: '§', summary: `Linked requirement ${text(d.clause_key) ?? 'unknown'}` }
    case 'requirement_unlinked':
      return { ...base, icon: '§', summary: `Unlinked requirement ${text(d.clause_key) ?? 'unknown'}` }
    case 'created_from_proposal':
      return { ...base, icon: '→', summary: 'Created from an approved proposal' }
    case 'promoted':
      return { ...base, icon: '→', summary: 'Approved and promoted to a Board task' }
    case 'outcome_changed':
      return { ...base, icon: '✓', summary: `Outcome: ${fromTo(d)}` }
    case 'decision_updated':
      return { ...base, icon: '✎', summary: 'Review note updated' }
    case 'requirements_changed':
      return { ...base, icon: '§', summary: 'Proposal requirements changed' }
    case 'legacy_repaired':
      return { ...base, icon: '✓', summary: 'Older proposal completed with required details' }
    default:
      return { ...base, icon: '•', summary: row.action.replaceAll('_', ' ') }
  }
}
