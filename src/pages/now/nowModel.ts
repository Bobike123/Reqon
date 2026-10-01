import type { Milestone } from '../../milestones/types.ts'
import { milestoneLabel } from '../../milestones/label.ts'
import type { Attention } from '../../metrics/types.ts'
import type { Proposal } from '../../proposals/types.ts'
import { toLocalDateString } from '../../lib/dates.ts'
import type { Task } from '../../tasks/types.ts'

// Every instrument on the Now screen, and the SQL that reproduces it.
// The queries themselves are in docs/now-metrics.sql — paste one into the
// Supabase SQL editor and it must agree with the tile. Nothing here invents a
// number; each function is the minimum arithmetic needed to turn rows the
// database already counted into a tile.

export type NextDeadline =
  | { kind: 'due'; milestoneKey: string; label: string; name: string; dueOn: string; days: number }
  // MS1-7 happens at the Final Event and has no published window. A milestone
  // with no due_on renders TBC — an invented deadline is worse than a blank.
  | { kind: 'tbc' }

// SOURCE: milestones.due_on, current season, earliest date not yet passed.
// docs/now-metrics.sql §1
export function nextDeadline(milestones: Milestone[], today: Date): NextDeadline {
  const todayIso = toLocalDateString(today)
  const upcoming = milestones
    .filter((m): m is Milestone & { due_on: string } => m.due_on !== null)
    .filter((m) => m.due_on >= todayIso)
    .sort((a, b) => a.due_on.localeCompare(b.due_on))[0]

  if (!upcoming) return { kind: 'tbc' }
  const days = Math.round(
    (Date.parse(`${upcoming.due_on}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) /
      86_400_000,
  )
  return {
    kind: 'due',
    milestoneKey: upcoming.key,
    // The display label (MS1-1), not the opaque key, which carries a season suffix after a rollover.
    label: milestoneLabel(upcoming),
    name: upcoming.name,
    dueOn: upcoming.due_on,
    days,
  }
}

// SOURCE: milestones.max_points for the current season, MS1 deliverables only — judged by the display
// label (milestoneLabel), the same rule the Milestones page uses, so a later season's opaque keys or a
// renamed code can never make the two screens disagree.
// Totals 600 for the MS2627 edition; read from the data, never hard-coded, so
// a future edition with different points shows its own number.
// docs/now-metrics.sql §3
export function ms1Points(milestones: Milestone[]): number {
  return milestones
    .filter((m) => milestoneLabel(m).startsWith('MS1'))
    .reduce((n, m) => n + (m.max_points ?? 0), 0)
}

// SOURCE: attention(p_season, p_today) where is_overdue. SQL owns the definition, against
// the reader's own day; archived tasks never appear. Counted by the independent FLAG, not by
// `reason`: a task that is blocked AND overdue has reason 'blocked' and used to be missing
// here (phase-01 F-07). docs/now-metrics.sql §4
export function overdueCount(attention: Attention[]): number {
  return attention.filter((a) => a.is_overdue).length
}

// SOURCE: task_proposals awaiting a decision or its outcome — suggested, under
// review, waiting for the author's changes, or approved and not yet promoted —
// not archived, in the current season. Parked work is set aside and decided work
// is history, so neither counts. docs/now-metrics.sql §5
export const UNRESOLVED_PROPOSAL_STATES = ['open', 'agenda', 'changes_requested', 'approved'] as const
// The states in which the REVIEWER has the next move: not `changes_requested`, which waits for the author.
export const REVIEWER_QUEUE_STATES: readonly string[] = ['open', 'agenda', 'approved']
export function openProposalsCount(proposals: Proposal[]): number {
  return proposals.filter((p) => (UNRESOLVED_PROPOSAL_STATES as readonly string[]).includes(p.state) && p.archived_at === null).length
}

// SOURCE: attention(p_season, p_today) where is_blocked — covers blocked rules AND
// blocked tasks in one place, again decided by SQL. docs/now-metrics.sql §6
export function blockedCount(attention: Attention[]): number {
  return attention.filter((a) => a.is_blocked).length
}

export function percent(resolved: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((resolved / total) * 100)
}

// ---------------------------------------------------- requirements progress
// The Requirements Book's own chapters (SECTION A–J) and subchapters
// (ARTICLEs, ANNEXes), in book order, from v_book_progress. The view counts
// from the rules themselves — where the book prints them — so a rule's
// department never moves it here, and a chapter's numbers are counted over
// its own rules rather than added up from its articles (nothing counted
// twice). A requirement is a rule that places a duty on the team; resolved =
// compliant or verified, out of the applicable ones: N/A ("does not apply") is
// left out of BOTH the numerator and the denominator and shown as its own count
// (PERMISSIONS §6.2). Task completion plays no part.
// docs/now-metrics.sql §2

export type BookCounts = {
  requirements: number
  // requirements minus N/A: the denominator of every compliance figure.
  applicable: number
  // compliant + verified, out of `applicable`; `verified` is also shown alone.
  complied: number
  verified: number
  // The legacy figure (N/A counted as resolved). Kept for one release; not shown.
  resolved: number
  notApplicable: number
  inProgress: number
  blocked: number
  importedRules: number
}

// What a row can honestly say:
//   measured         — team requirements exist; show resolved/total and a bar.
//   no-requirements  — rules are imported, but none places a duty on the team.
//   not-imported     — the book numbers rules here, the Register has none
//                      (missing data).
//   out-of-scope     — the chapter is specific to another category than the
//                      season's (Section D, Electric, in an eFuel season): left
//                      out on purpose, so not missing data. Only its page shows.
//   no-rules-in-book — the book itself has no numbered rules here (a
//                      glossary, an annex): a confirmed zero.
export type BookStatus = 'measured' | 'no-requirements' | 'not-imported' | 'out-of-scope' | 'no-rules-in-book'

export type BookUnit = {
  // 'A' for a chapter, 'A.3' for an article, 'J.annex-2' for an annex.
  id: string
  label: string
  heading: string
  page: number | null
  status: BookStatus
  counts: BookCounts
  percent: number | null
  // The Register filter that shows exactly these rules (?chapter=), or null
  // when there are no rules to show.
  registerFilter: string | null
}

export type BookChapter = BookUnit & { subchapters: BookUnit[] }

type BookRow = {
  level: string | null
  chapter_code: string | null
  kind: string | null
  number: number | null
  label: string | null
  heading: string | null
  page: number | null
  chapter_sort: number | null
  sort_order: number | null
  has_numbered_rules: boolean | null
  out_of_scope?: boolean | null
  // v_book_progress (20260129000100). Absent on older rows, which fall back to the legacy columns.
  content_state?: string | null
  applicable?: number | null
  complied?: number | null
  verified?: number | null
  imported_rules: number | null
  requirements: number | null
  resolved: number | null
  not_applicable: number | null
  in_progress: number | null
  blocked: number | null
}

function unitOf(row: BookRow): BookUnit {
  const requirements = row.requirements ?? 0
  const notApplicable = row.not_applicable ?? 0
  const counts: BookCounts = {
    requirements,
    applicable: row.applicable ?? requirements - notApplicable,
    complied: row.complied ?? Math.max(0, (row.resolved ?? 0) - notApplicable),
    verified: row.verified ?? 0,
    resolved: row.resolved ?? 0,
    notApplicable,
    inProgress: row.in_progress ?? 0,
    blocked: row.blocked ?? 0,
    importedRules: row.imported_rules ?? 0,
  }
  // The view says what a zero MEANS (content_state); rows without it use the same rules.
  const status: BookStatus =
    row.content_state === 'out_of_scope' ? 'out-of-scope'
    : row.content_state === 'not_imported' ? 'not-imported'
    : row.content_state === 'no_numbered_rules' ? 'no-rules-in-book'
    : counts.importedRules > 0
      ? counts.requirements > 0 ? 'measured' : 'no-requirements'
      : row.out_of_scope ? 'out-of-scope'
      : row.has_numbered_rules ? 'not-imported' : 'no-rules-in-book'
  const chapter = row.chapter_code ?? '?'
  const isChapter = row.level === 'chapter'
  const id = isChapter ? chapter : row.kind === 'article' ? `${chapter}.${row.number}` : `${chapter}.${row.kind}-${row.number}`
  return {
    id,
    label: row.label ?? id,
    heading: row.heading ?? '',
    page: row.page,
    status,
    counts,
    // Every requirement N/A: nothing to resolve, so no percentage (never 0 % or 100 %).
    percent: status === 'measured' && counts.applicable > 0 ? percent(counts.complied, counts.applicable) : null,
    registerFilter: counts.importedRules > 0 && (isChapter || row.kind === 'article') ? id : null,
  }
}

export function bookProgressTree(rows: readonly BookRow[]): BookChapter[] {
  const bySort = (a: BookRow, b: BookRow) =>
    (a.chapter_sort ?? 0) - (b.chapter_sort ?? 0) || (a.sort_order ?? 0) - (b.sort_order ?? 0)
  const ordered = [...rows].sort(bySort)
  const chapters = ordered
    .filter((r) => r.level === 'chapter')
    .map((c) => ({
      ...unitOf(c),
      subchapters: ordered.filter((s) => s.level === 'subchapter' && s.chapter_code === c.chapter_code).map(unitOf),
    }))
  // Chapters with no rules of their own (another category's section, a glossary,
  // annexes) go last, each group keeping the book's order. Missing data stays
  // where the book puts it, so it is not buried.
  const last = (c: BookChapter) => c.status === 'out-of-scope' || c.status === 'no-rules-in-book'
  return [...chapters.filter((c) => !last(c)), ...chapters.filter(last)]
}

// The whole book: chapters partition the rules, so their sum counts each
// requirement exactly once.
export function bookTotals(chapters: readonly BookChapter[]): BookCounts {
  const zero: BookCounts = { requirements: 0, applicable: 0, complied: 0, verified: 0, resolved: 0, notApplicable: 0, inProgress: 0, blocked: 0, importedRules: 0 }
  return chapters.reduce(
    (sum, c) => ({
      requirements: sum.requirements + c.counts.requirements,
      applicable: sum.applicable + c.counts.applicable,
      complied: sum.complied + c.counts.complied,
      verified: sum.verified + c.counts.verified,
      resolved: sum.resolved + c.counts.resolved,
      notApplicable: sum.notApplicable + c.counts.notApplicable,
      inProgress: sum.inProgress + c.counts.inProgress,
      blocked: sum.blocked + c.counts.blocked,
      importedRules: sum.importedRules + c.counts.importedRules,
    }),
    zero,
  )
}

// Active, unfinished tasks due from today up to `days` ahead, soonest first.
// Overdue work is listed separately, so it is not repeated here.
export function upcomingDeadlines<T extends Pick<Task, 'due_date' | 'state' | 'archived_at'>>(tasks: readonly T[], today: string, days: number): T[] {
  const until = addDays(today, days)
  return tasks
    .filter((t) => t.archived_at === null && t.state !== 'done' && t.state !== 'cancelled')
    .filter((t): t is T & { due_date: string } => t.due_date !== null && t.due_date >= today && t.due_date <= until)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
}

// The viewer's own unfinished, active tasks: overdue first, then by deadline,
// undated last.
export function myOpenTasks<T extends Pick<Task, 'owner_id' | 'due_date' | 'state' | 'archived_at'>>(tasks: readonly T[], myId: string | null): T[] {
  if (!myId) return []
  return tasks
    .filter((t) => t.owner_id === myId && t.archived_at === null && t.state !== 'done' && t.state !== 'cancelled')
    .sort((a, b) => (a.due_date ?? '9999-12-31').localeCompare(b.due_date ?? '9999-12-31'))
}

// Rows of the attention list for one reason, in the SQL's own terms. 'overdue', 'blocked' and 'urgent' are
// the independent flags (a blocked task that is also overdue is in both lists, as it is in both counts);
// any other reason is matched on `reason` itself.
export function attentionFor(attention: readonly Attention[], reason: string): Attention[] {
  switch (reason) {
    case 'overdue':
      return attention.filter((a) => a.is_overdue)
    case 'blocked':
      return attention.filter((a) => a.is_blocked)
    case 'urgent':
      return attention.filter((a) => a.is_urgent)
    case 'starred':
      return attention.filter((a) => a.is_starred)
    default:
      return attention.filter((a) => a.reason === reason)
  }
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
