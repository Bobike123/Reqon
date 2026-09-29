import { describe, expect, it } from 'vitest'
import type { Task } from '../../tasks/types.ts'
import {
  canUnlinkMilestone,
  linkCandidates,
  linkEdit,
  relinkFrom,
  unlinkMilestoneEdit,
  unlinkSectionEdit,
  type LinkTarget,
} from './ganttLinking.ts'

type L = Pick<Task, 'id' | 'title' | 'season_id' | 'archived_at' | 'milestone_key' | 'section_id' | 'links_required'>
const t = (id: string, over: Partial<L> = {}): L => ({
  id, title: id, season_id: 's', archived_at: null, milestone_key: null, section_id: null, links_required: false, ...over,
})
const SECTION: LinkTarget = { seasonId: 's', milestoneKey: 'M1', sectionId: 'sec1' }
const MILESTONE: LinkTarget = { seasonId: 's', milestoneKey: 'M1', sectionId: null }
const always = () => true
const ids = (list: L[]) => list.map((x) => x.id)

describe('linkCandidates', () => {
  it('splits what can be linked as it is from what would MOVE from another milestone', () => {
    const tasks = [
      t('loose'),
      t('same-milestone-unsectioned', { milestone_key: 'M1' }),
      t('other-milestone', { milestone_key: 'M2', section_id: 'x' }),
    ]
    const { direct, relink } = linkCandidates(tasks, SECTION, always)
    expect(ids(direct)).toEqual(['loose', 'same-milestone-unsectioned'])
    expect(ids(relink)).toEqual(['other-milestone'])
  })

  it('never offers an archived task, or one from another season', () => {
    const tasks = [t('archived', { archived_at: '2026-10-01T00:00:00Z' }), t('other-season', { season_id: 'z' }), t('fine')]
    expect(ids(linkCandidates(tasks, SECTION, always).direct)).toEqual(['fine'])
  })

  it('offers only what the person may edit (owner, Head or Developer decides upstream)', () => {
    const tasks = [t('mine'), t('theirs')]
    const { direct } = linkCandidates(tasks, SECTION, (task) => task.id === 'mine')
    expect(ids(direct)).toEqual(['mine'])
  })

  it('does not offer a task that is already exactly there', () => {
    const tasks = [t('here', { milestone_key: 'M1', section_id: 'sec1' }), t('elsewhere-in-milestone', { milestone_key: 'M1', section_id: 'sec2' })]
    const { direct, relink } = linkCandidates(tasks, SECTION, always)
    expect(ids(direct)).toEqual(['elsewhere-in-milestone']) // moving between sections of one milestone is direct
    expect(relink).toEqual([])
  })

  it('for the unsectioned group, offers loose tasks, sectioned ones of the same milestone stay out of "already here"', () => {
    const tasks = [t('already', { milestone_key: 'M1' }), t('loose'), t('in-section', { milestone_key: 'M1', section_id: 'sec1' })]
    const { direct } = linkCandidates(tasks, MILESTONE, always)
    expect(ids(direct)).toEqual(['in-section', 'loose'])
  })

  it('sorts by title', () => {
    expect(ids(linkCandidates([t('b'), t('a')], SECTION, always).direct)).toEqual(['a', 'b'])
  })
})

describe('the edits', () => {
  it('a link always sends milestone AND section together, so a relink is atomic', () => {
    expect(linkEdit({ id: 'x' }, SECTION)).toEqual({ id: 'x', sectionId: 'sec1', milestoneKey: 'M1' })
    expect(linkEdit({ id: 'x' }, MILESTONE)).toEqual({ id: 'x', sectionId: null, milestoneKey: 'M1' })
  })

  it('unlinking a section touches only the section: the milestone stays', () => {
    expect(unlinkSectionEdit({ id: 'x' })).toEqual({ id: 'x', sectionId: null })
    expect('milestoneKey' in unlinkSectionEdit({ id: 'x' })).toBe(false)
  })

  it('unlinking a milestone clears both, and is not offered for promoted work', () => {
    expect(unlinkMilestoneEdit({ id: 'x' })).toEqual({ id: 'x', sectionId: null, milestoneKey: null })
    expect(canUnlinkMilestone({ links_required: false })).toBe(true)
    expect(canUnlinkMilestone({ links_required: true })).toBe(false)
  })

  it('names where a task is moving from', () => {
    const name = (id: string) => (id === 'sec9' ? 'Loads' : null)
    expect(relinkFrom({ milestone_key: 'M2', section_id: 'sec9' }, name)).toBe('M2 · Loads')
    expect(relinkFrom({ milestone_key: 'M2', section_id: null }, name)).toBe('M2')
    expect(relinkFrom({ milestone_key: null, section_id: null }, name)).toBe('no milestone')
  })
})
