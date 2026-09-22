import type { Database } from '../../lib/database.types.ts'

// The roster has TWO different things called a "role", and confusing them is
// the whole reason this file exists:
//
//   members.role        free text, e.g. "Chassis" or "Aerodynamics" — a JOB
//                       TITLE. It grants nothing. Default 'Member'.
//   member_roles.role   the privileged_role enum (President, Vice President,
//                       Treasurer, Developer) — what the DATABASE lets someone
//                       do. Handed out in the role dialog, never typed.
//
// Everything here is about the first one. The second lives in auth/permissions.ts.

export type RosterMember = Pick<
  Database['public']['Tables']['members']['Row'],
  'id' | 'full_name' | 'role' | 'status'
>

// The schema default (20260101000000_paddock_control_schema.sql: role text not
// null default 'Member'), so it is always an offered choice.
export const DEFAULT_JOB_TITLE = 'Member'

// The job titles to offer in the dropdown: the ones the club already uses.
// Nothing is seeded and no table is needed — the roster IS the list, which is
// why the first person to hold a title types it once and nobody retypes (or
// mistypes) it again.
//
// `extra` keeps a value that is not on anyone else — the title being edited,
// so a select always has its own value to show.
export function jobTitleOptions(
  members: readonly RosterMember[],
  ...extra: readonly (string | null | undefined)[]
): string[] {
  const seen = new Map<string, string>()
  const add = (raw: string | null | undefined) => {
    const title = (raw ?? '').trim()
    if (!title) return
    // "Chassis" and "chassis" are one title; the first spelling on the roster
    // wins, so the list does not fill up with near-duplicates.
    const key = title.toLowerCase()
    if (!seen.has(key)) seen.set(key, title)
  }

  add(DEFAULT_JOB_TITLE)
  for (const member of members) add(member.role)
  for (const value of extra) add(value)

  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

// Active people first and alumni after, instead of one list where a retired
// name sits between two current ones. Both keep the roster's name order.
export function splitRoster<T extends RosterMember>(members: readonly T[]): {
  active: T[]
  alumni: T[]
} {
  return {
    active: members.filter((m) => m.status !== 'alumni'),
    alumni: members.filter((m) => m.status === 'alumni'),
  }
}
