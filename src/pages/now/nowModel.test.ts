import { describe, expect, it } from 'vitest'
import type { Milestone } from '../../data/useMilestones.ts'
import type { Attention, BookProgress } from '../../metrics/types.ts'
import type { Proposal } from '../../data/useProposals.ts'
import {
  attentionFor,
  blockedCount,
  bookProgressTree,
  bookTotals,
  myOpenTasks,
  upcomingDeadlines,
  ms1Points,
  nextDeadline,
  openProposalsCount,
  overdueCount,
  percent,
} from './nowModel.ts'

const TODAY = new Date('2026-09-09T12:00:00Z')

function ms(key: string, due: string | null, points: number): Milestone {
  return { key, season_id: 's', ordinal: 1, name: key, aim: null, article_ref: null,
    opens_on: null, due_on: due, max_points: points, is_blocking: false, notes: null } as Milestone
}
function att(reason: string, flags: Partial<Attention> = {}): Attention {
  return { kind: 'clause', ref: 'X', title: 't', owner_id: null, season_id: 's',
    reason, starred: false, clause_key: 'X',
    is_overdue: reason === 'overdue', is_blocked: reason === 'blocked', is_urgent: reason === 'urgent', is_starred: false, ...flags } as Attention
}
function proposal(state: string): Proposal {
  return { id: 'x', season_id: 's', title: 't', state, archived_at: null } as unknown as Proposal
}

describe('next deadline', () => {
  it('picks the earliest future milestone and counts the days', () => {
    const d = nextDeadline([ms('MS1-2', '2027-02-28', 100), ms('MS1-1', '2026-11-30', 75)], TODAY)
    expect(d.kind).toBe('due')
    if (d.kind === 'due') {
      expect(d.milestoneKey).toBe('MS1-1')
      expect(d.days).toBe(82)
    }
  })

  it('ignores milestones whose date has passed', () => {
    const d = nextDeadline([ms('OLD', '2026-01-01', 10), ms('MS1-1', '2026-11-30', 75)], TODAY)
    expect(d.kind === 'due' && d.milestoneKey).toBe('MS1-1')
  })

  it('renders TBC rather than inventing a date when due_on is null', () => {
    // MS1-7 happens at the Final Event and has no published window.
    expect(nextDeadline([ms('MS1-7', null, 60)], TODAY).kind).toBe('tbc')
  })

  it('renders TBC when there are no milestones at all', () => {
    expect(nextDeadline([], TODAY).kind).toBe('tbc')
  })
})

describe('percent with nothing to count', () => {
  it('does not divide by zero', () => {
    expect(percent(0, 0)).toBe(0)
  })
})

describe('MS1 points', () => {
  it('sums the MS1 milestones and excludes the Rider Eligibility Declaration', () => {
    const points = ms1Points([
      ms('MS1-1', '2026-11-30', 75), ms('MS1-2', '2027-02-28', 100),
      ms('MS1-3', '2027-04-30', 150), ms('MS1-4', '2027-05-31', 60),
      ms('MS1-5', '2027-05-31', 75), ms('MS1-6', '2027-06-30', 80),
      ms('MS1-7', null, 60), ms('RED', '2027-08-31', 0),
    ])
    expect(points).toBe(600)
  })

  it('reads the number from the data rather than hard-coding 600', () => {
    // A future edition with different points must show its own total.
    expect(ms1Points([ms('MS1-1', null, 10), ms('MS1-2', null, 15)])).toBe(25)
  })

  it('is zero when no milestones exist', () => {
    expect(ms1Points([])).toBe(0)
  })
})

describe('counts from v_attention', () => {
  it('counts overdue and blocked by the independent flags', () => {
    const rows = [att('overdue'), att('blocked'), att('blocked'), att('starred'), att('penalty')]
    expect(overdueCount(rows)).toBe(1)
    expect(blockedCount(rows)).toBe(2)
  })

  it('a task that is blocked AND overdue counts in both (its reason is only the first one)', () => {
    const both = att('blocked', { is_overdue: true })
    expect(overdueCount([both, att('overdue')])).toBe(2)
    expect(blockedCount([both, att('overdue')])).toBe(1)
    expect(attentionFor([both, att('overdue')], 'overdue')).toHaveLength(2)
    expect(attentionFor([both], 'blocked')).toHaveLength(1)
  })

  it('is zero on an empty list', () => {
    expect(overdueCount([])).toBe(0)
    expect(blockedCount([])).toBe(0)
  })
})

describe('open proposals', () => {
  it('counts proposals awaiting a decision: suggested and under review', () => {
    expect(openProposalsCount([proposal('open'), proposal('open'), proposal('agenda'), proposal('decided'), proposal('parked')])).toBe(3)
  })
  it('also counts a proposal waiting for the author\'s changes and one approved but not yet promoted', () => {
    expect(openProposalsCount([proposal('changes_requested'), proposal('approved'), proposal('decided')])).toBe(2)
  })
  it('never counts an archived proposal, whatever its stage', () => {
    const archived = { ...proposal('open'), archived_at: '2026-09-01T00:00:00Z' }
    expect(openProposalsCount([archived, proposal('open')])).toBe(1)
  })
  it('is zero on an empty list', () => {
    expect(openProposalsCount([])).toBe(0)
  })
})

describe('percent', () => {
  it('rounds and guards against an empty denominator', () => {
    expect(percent(2, 433)).toBe(0)
    expect(percent(217, 433)).toBe(50)
    expect(percent(5, 0)).toBe(0)
  })
})

describe('requirements progress by book chapter (Now)', () => {
  const row = (over: Partial<BookProgress>): BookProgress =>
    ({ season_id: 's', regs_ref: 'R', level: 'chapter', chapter_code: 'A', kind: null, number: null,
       label: 'SECTION A', heading: 'H', page: 1, chapter_sort: 1, sort_order: 0, has_numbered_rules: true,
       imported_rules: 0, requirements: 0, resolved: 0, not_applicable: 0, in_progress: 0, blocked: 0,
       applicable: 0, complied: 0, verified: 0, content_state: null, ...over }) as BookProgress
  const rows = [
    // Deliberately out of order: the tree must follow the book, not the query.
    row({ level: 'subchapter', chapter_code: 'A', kind: 'article', number: 2, label: 'ARTICLE 2', sort_order: 2,
          imported_rules: 5, requirements: 0 }),
    row({ chapter_code: 'D', label: 'SECTION D', chapter_sort: 4, page: 82, out_of_scope: true }),
    row({ chapter_code: 'K', label: 'SECTION K', chapter_sort: 11 }),
    row({ chapter_code: 'A', imported_rules: 15, requirements: 10, resolved: 4, not_applicable: 1, applicable: 9, complied: 3, verified: 1 }),
    row({ level: 'subchapter', chapter_code: 'A', kind: 'article', number: 1, label: 'ARTICLE 1', sort_order: 1,
          imported_rules: 10, requirements: 10, resolved: 4, not_applicable: 1, applicable: 9, complied: 3, verified: 1 }),
    row({ chapter_code: 'J', label: 'SECTION J', chapter_sort: 10, has_numbered_rules: false }),
    row({ level: 'subchapter', chapter_code: 'J', kind: 'annex', number: 1, label: 'ANNEX 1', chapter_sort: 10,
          sort_order: 3, has_numbered_rules: false }),
  ]

  it('lists every chapter in book order, each with its own subchapters in book order', () => {
    const tree = bookProgressTree(rows)
    expect(tree.map((c) => c.id)).toEqual(['A', 'K', 'D', 'J'])
    expect(tree[0].subchapters.map((s) => s.id)).toEqual(['A.1', 'A.2'])
    expect(tree[3].subchapters.map((s) => s.id)).toEqual(['J.annex-1'])
  })

  it('takes the chapter numbers from the chapter row itself, and reports not-applicable separately', () => {
    const [a] = bookProgressTree(rows)
    expect(a.status).toBe('measured')
    // N/A is left out of numerator AND denominator: 3 complied of 9 that apply, not 4 of 10.
    expect(a.counts).toMatchObject({ requirements: 10, applicable: 9, complied: 3, verified: 1, notApplicable: 1 })
    expect(a.percent).toBe(33)
    expect(a.registerFilter).toBe('A')
    expect(a.subchapters[0].registerFilter).toBe('A.1')
  })

  it('a chapter whose every requirement is N/A has nothing to resolve: no percentage, never 0 % or 100 %', () => {
    const [a] = bookProgressTree([row({ chapter_code: 'A', imported_rules: 3, requirements: 3, resolved: 3, not_applicable: 3, applicable: 0, complied: 0 })])
    expect(a.status).toBe('measured')
    expect(a.percent).toBeNull()
  })

  it('reads the view\'s content_state, so a zero is labelled for what it means', () => {
    const tree = bookProgressTree([
      row({ chapter_code: 'A', content_state: 'not_imported', has_numbered_rules: true }),
      row({ chapter_code: 'B', chapter_sort: 2, content_state: 'out_of_scope' }),
      row({ chapter_code: 'C', chapter_sort: 3, content_state: 'no_numbered_rules', has_numbered_rules: false }),
    ])
    expect(tree.map((c) => [c.id, c.status])).toEqual([['A', 'not-imported'], ['B', 'out-of-scope'], ['C', 'no-rules-in-book']])
  })

  it('falls back to the legacy columns for a row from before the view had applicable/complied', () => {
    const [a] = bookProgressTree([row({ chapter_code: 'A', imported_rules: 5, requirements: 5, resolved: 3, not_applicable: 1, applicable: undefined, complied: undefined, verified: undefined })])
    expect(a.counts).toMatchObject({ applicable: 4, complied: 2 })
  })

  it('tells missing data apart from a confirmed zero', () => {
    const [a, k, d, j] = bookProgressTree(rows)
    expect(a.subchapters[1].status).toBe('no-requirements')
    expect(a.subchapters[1].percent).toBeNull()
    expect(d.status).toBe('out-of-scope')
    expect(d.page).toBe(82)
    expect(d.registerFilter).toBeNull()
    expect(k.status).toBe('not-imported')
    expect(j.status).toBe('no-rules-in-book')
    expect(j.subchapters[0].status).toBe('no-rules-in-book')
    expect(j.subchapters[0].registerFilter).toBeNull()
  })

  it('adds up the whole book from its chapters, so no requirement is counted twice', () => {
    expect(bookTotals(bookProgressTree(rows))).toMatchObject({ requirements: 10, resolved: 4, notApplicable: 1, importedRules: 15 })
    expect(bookTotals([])).toMatchObject({ requirements: 0, resolved: 0 })
  })
})

describe('Now action lists', () => {
  const t = (id: string, over: Record<string, unknown>) => ({ id, owner_id: null, due_date: null, state: 'todo', archived_at: null, ...over }) as never

  it('lists deadlines from today up to N days ahead, soonest first, without overdue, finished or archived work', () => {
    const list = upcomingDeadlines(
      [
        t('late', { due_date: '2026-09-08' }),
        t('today', { due_date: '2026-09-09' }),
        t('soon', { due_date: '2026-09-12' }),
        t('far', { due_date: '2026-09-30' }),
        t('done', { due_date: '2026-09-10', state: 'done' }),
        t('arch', { due_date: '2026-09-10', archived_at: '2026-09-01T00:00:00Z' }),
      ],
      '2026-09-09',
      7,
    ) as { id: string }[]
    expect(list.map((x) => x.id)).toEqual(['today', 'soon'])
  })

  it("lists the viewer's own open work, dated first and undated last, and nothing when signed out", () => {
    const tasks = [t('b', { owner_id: 'me', due_date: '2026-10-01' }), t('c', { owner_id: 'me' }), t('a', { owner_id: 'me', due_date: '2026-09-01' }), t('x', { owner_id: 'other' }), t('d', { owner_id: 'me', state: 'cancelled' })]
    expect((myOpenTasks(tasks, 'me') as { id: string }[]).map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(myOpenTasks(tasks, null)).toEqual([])
  })

  it('picks attention rows by the reason the SQL gave', () => {
    expect(attentionFor([att('overdue'), att('blocked'), att('overdue')], 'overdue')).toHaveLength(2)
  })
})

describe('the shared attention filter (Now tiles and Priorities chips)', () => {
  const row = (ref: string, reason: string, flags: Partial<Attention> = {}) =>
    ({ kind: 'task', ref, title: ref, owner_id: null, season_id: 's', reason, starred: false, clause_key: null, is_overdue: false, is_blocked: false, is_urgent: false, is_starred: false, ...flags }) as Attention

  it('lists a blocked task that is also overdue under both, and starred under starred', () => {
    const rows = [
      row('both', 'blocked', { is_blocked: true, is_overdue: true }),
      row('late', 'overdue', { is_overdue: true }),
      row('fav', 'starred', { is_starred: true }),
    ]
    expect(attentionFor(rows, 'overdue').map((r) => r.ref)).toEqual(['both', 'late'])
    expect(attentionFor(rows, 'blocked').map((r) => r.ref)).toEqual(['both'])
    expect(attentionFor(rows, 'starred').map((r) => r.ref)).toEqual(['fav'])
  })

  it('names the next submission by its display label, not its opaque key', () => {
    const due = nextDeadline([{ ...ms('MS1-1~1a2b3c4d', '2026-11-30', 75), code: 'MS1-1' }], TODAY)
    expect(due).toMatchObject({ kind: 'due', milestoneKey: 'MS1-1~1a2b3c4d', label: 'MS1-1' })
  })
})
