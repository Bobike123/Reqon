import { describe, expect, it } from 'vitest'
import { departmentRollup, sectionRollup, taskProgress } from './progress.ts'

// The SAME fixture as supabase/tests/progress_views_test.sql, with the SAME expected figures, so the SQL view
// (authoritative) and this mirror cannot drift apart. Format: total|done|archivedDone|archivedUnfinished|cancelled|openActive|percent.
const line = (p: ReturnType<typeof taskProgress>) =>
  [p.total, p.done, p.archivedDone, p.archivedUnfinished, p.cancelled, p.openActive, p.percent === null ? 'null' : p.percent].join('|')

const ARCHIVED = '2026-10-01T00:00:00Z'
const t = (id: string, state: 'todo' | 'wip' | 'done' | 'cancelled' | 'blocked', subteam_key: string | null, over: { archived?: boolean; section_id?: string | null } = {}) => ({
  id, state, subteam_key, section_id: over.section_id ?? null, archived_at: over.archived ? ARCHIVED : null,
})

describe('the one progress rule (mirror of v_task_progress)', () => {
  const departments = [
    { key: 'PARENT', parent_key: null }, { key: 'CHILD_A', parent_key: 'PARENT' }, { key: 'CHILD_B', parent_key: 'PARENT' },
  ]
  const tasks = [
    t('parent-done', 'done', 'PARENT'), t('parent-todo', 'todo', 'PARENT'),
    t('a-done-archived', 'done', 'CHILD_A', { archived: true }), t('a-wip-archived', 'wip', 'CHILD_A', { archived: true }),
    t('a-cancelled', 'cancelled', 'CHILD_A'), t('b-todo', 'todo', 'CHILD_B'),
  ]

  it('archived DONE keeps its contribution; archived UNFINISHED stays undone and is reported; cancelled leaves the denominator', () => {
    expect(line(taskProgress(tasks.filter((x) => x.subteam_key === 'CHILD_A')))).toBe('2|1|1|1|1|0|50')
  })

  it('a department with open work only is a real 0 %; one with nothing but cancelled work is "no linked work" (null)', () => {
    expect(line(taskProgress(tasks.filter((x) => x.subteam_key === 'CHILD_B')))).toBe('1|0|0|0|0|1|0')
    expect(line(taskProgress([t('only', 'cancelled', 'X')]))).toBe('0|0|0|0|1|0|null')
    expect(taskProgress([]).percent).toBeNull()
  })

  it('the roll-up comes from the UNIQUE tasks of the parent and its children (40 %), not from averaging 50 % and 0 %', () => {
    expect(line(departmentRollup(tasks, departments, 'PARENT'))).toBe('5|2|1|1|1|2|40')
    expect(line(departmentRollup(tasks, departments, 'CHILD_A'))).toBe('2|1|1|1|1|0|50')
  })

  it('a section counts its subsection\'s tasks once: 2 of 3 = 67 %, not the average of 100 % and 50 %', () => {
    const sections = [{ id: 'sec1', parent_section_id: null }, { id: 'sub1', parent_section_id: 'sec1' }]
    const work = [
      t('A', 'done', 'P', { section_id: 'sec1' }), t('B', 'wip', 'P', { section_id: 'sub1' }), t('C', 'done', 'P', { section_id: 'sub1' }),
    ]
    expect(line(sectionRollup(work, sections, 'sub1'))).toBe('2|1|0|0|0|1|50')
    expect(line(sectionRollup(work, sections, 'sec1'))).toBe('3|2|0|0|0|1|67')
  })

  it('counts a task that appears twice (two requirement links) once', () => {
    const c = t('C', 'done', 'P')
    expect(line(taskProgress([c, c, t('B', 'wip', 'P'), c]))).toBe('2|1|0|0|0|1|50')
  })
})
