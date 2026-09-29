import { describe, expect, it } from 'vitest'
import type { ActivityRow } from './types.ts'
import { actorLabel, presentActivity } from './presentation.ts'

const names = new Map([['m1', 'Ada Rider'], ['m2', 'Lin Driver']])
const row = (action: string, detail: Record<string, unknown>, actorId: string | null = 'm1'): ActivityRow => ({
  id: 1, season_id: 's1', entity: 'task', entity_id: 't1', action,
  actor_id: actorId, at: '2026-09-24T12:00:00Z', detail,
}) as ActivityRow

describe('activity presentation', () => {
  it('names blocked transitions and deadline movements instead of exposing raw JSON', () => {
    expect(presentActivity(row('state_changed', { from: 'wip', to: 'blocked' }), names)).toMatchObject({
      icon: '!', summary: 'State: wip → blocked',
    })
    expect(presentActivity(row('deadline_changed', { from: '2026-10-01', to: '2026-10-08' }), names).summary)
      .toMatch(/Deadline: 1 Oct 2026 → 8 Oct 2026/)
  })

  it('resolves people, link provenance and missing former actors', () => {
    expect(presentActivity(row('owner_changed', { from: 'm1', to: 'm2' }), names).summary)
      .toBe('Owner: Ada Rider → Lin Driver')
    expect(presentActivity(row('created_from_proposal', { proposal_id: 'p1' }), names).proposalId).toBe('p1')
    expect(actorLabel(row('archived', { actor_kind: 'system' }, null), names)).toBe('Automatic archive scheduler')
    expect(actorLabel(row('state_changed', {}, 'former'), names)).toBe('Former team member')
  })
})
