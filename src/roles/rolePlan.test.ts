import { describe, expect, it } from 'vitest'
import type { PrivilegedRole } from '../auth/permissions.ts'
import { planRoleChanges, type Person, type PlanInput } from './rolePlan.ts'

const ADA: Person = { id: 'ada', name: 'Ada' } // the President using the screen
const BO: Person = { id: 'bo', name: 'Bo' }
const CY: Person = { id: 'cy', name: 'Cy' }
const DI: Person = { id: 'di', name: 'Di' }
const EVE: Person = { id: 'eve', name: 'Eve' }

const HOLDERS: Record<PrivilegedRole, Person[]> = {
  president: [ADA],
  vicepresident: [CY],
  treasurer: [EVE],
  developer: [DI],
}

const plan = (over: Partial<PlanInput>) =>
  planRoleChanges({
    target: BO,
    desired: [],
    me: ADA,
    holders: HOLDERS,
    replaceTreasurer: true,
    stepDown: false,
    ...over,
  })

const steps = (p: ReturnType<typeof plan>) => p.changes.map((c) => `${c.action} ${c.memberId} ${c.role}`)

describe('planning a role change', () => {
  it('does nothing when nothing changed', () => {
    const p = plan({ target: CY, desired: ['vicepresident'] })
    expect(p.changes).toEqual([])
    expect(p.needsConfirmation).toBe(false)
  })

  it('saves Developer and Vice President changes without asking twice', () => {
    expect(plan({ desired: ['developer'] }).needsConfirmation).toBe(false)
    expect(plan({ target: CY, desired: [] }).needsConfirmation).toBe(false)
  })

  it('asks before making someone President, and says it includes power over your own roles', () => {
    const p = plan({ desired: ['president'] })
    expect(steps(p)).toEqual(['add bo president'])
    expect(p.needsConfirmation).toBe(true)
    expect(p.consequences[0]).toMatch(/Bo becomes President .*including yours/)
    expect(p.canStepDown).toBe(true)
  })

  it('hands over in a safe order: the new President first, stepping down last', () => {
    const p = plan({ desired: ['president'], stepDown: true })
    expect(steps(p)).toEqual(['add bo president', 'remove ada president'])
    expect(p.blocked).toBeNull()
    expect(p.consequences).toContain(
      'You stop being President. You lose role management straight away and cannot give it back to yourself.',
    )
  })

  it('refuses to plan away the last President', () => {
    const p = plan({ target: ADA, desired: [] })
    expect(p.blocked).toMatch(/You are the only President/)
  })

  it('lets a President step down when another President remains, asking first', () => {
    const p = plan({ target: ADA, desired: [], holders: { ...HOLDERS, president: [ADA, CY] } })
    expect(p.blocked).toBeNull()
    expect(steps(p)).toEqual(['remove ada president'])
    expect(p.needsConfirmation).toBe(true)
  })

  it('puts giving up your own presidency after every other change', () => {
    const p = plan({ target: ADA, desired: ['developer'], holders: { ...HOLDERS, president: [ADA, CY] } })
    expect(steps(p)).toEqual(['add ada developer', 'remove ada president'])
  })

  it('replaces the Treasurer by granting before removing', () => {
    const p = plan({ desired: ['treasurer'] })
    expect(p.otherTreasurers).toEqual([EVE])
    expect(steps(p)).toEqual(['add bo treasurer', 'remove eve treasurer'])
    expect(p.consequences).toContain('Eve is no longer Treasurer and can no longer change financial entries.')
    expect(p.needsConfirmation).toBe(true)
  })

  it('can keep both Treasurers', () => {
    expect(steps(plan({ desired: ['treasurer'], replaceTreasurer: false }))).toEqual(['add bo treasurer'])
  })

  it('warns when nobody would be left to manage money', () => {
    const p = plan({ target: EVE, desired: [] })
    expect(p.consequences).toContain('Nobody will be able to change financial entries until someone is made Treasurer.')
  })

  it('handles several roles at once, grants first', () => {
    const p = plan({ target: DI, desired: ['treasurer', 'vicepresident'], replaceTreasurer: false })
    expect(steps(p)).toEqual(['add di vicepresident', 'add di treasurer', 'remove di developer'])
  })
})
