import { PRIVILEGED_ROLES, ROLE_LABELS, sortRoles, type PrivilegedRole } from '../auth/permissions.ts'

// Turns "these are the roles Bo should have" into the exact writes to make, in
// a safe order, with the consequences spelled out. Pure, so every rule here is
// unit-tested without a screen.
//
// It decides nothing about who is ALLOWED: the database does that. It exists
// so the President sees what a change means before making it, and so a
// hand-over never passes through a moment with no President.

export type Person = { id: string; name: string }

export type RoleChange = {
  memberId: string
  memberName: string
  role: PrivilegedRole
  action: 'add' | 'remove'
}

export type PlanInput = {
  target: Person
  desired: readonly PrivilegedRole[]
  me: Person
  // Everyone holding each role right now (from member_roles).
  holders: Readonly<Record<PrivilegedRole, readonly Person[]>>
  // When the target becomes Treasurer and someone else already is: take it
  // away from them (true), or keep two Treasurers (false).
  replaceTreasurer: boolean
  // When the President gives President to someone else: step down as well.
  stepDown: boolean
}

export type RolePlan = {
  changes: RoleChange[]
  consequences: string[]
  needsConfirmation: boolean
  blocked: string | null
  otherTreasurers: Person[]
  canStepDown: boolean
}

const GAINS: Record<PrivilegedRole, string> = {
  president: 'can change every setting and give or take away anyone’s roles',
  vicepresident: 'can change the roster, subsystems, milestones and seasons',
  treasurer: 'can add, edit and delete financial entries',
  developer: 'can do everything in the club, roles and money included',
}

const LOSES: Record<PrivilegedRole, string> = {
  president: 'can no longer give or take away roles',
  vicepresident: 'can no longer change the roster, subsystems, milestones or seasons',
  treasurer: 'can no longer change financial entries',
  developer: 'loses full access to the club’s data',
}

export function joinNames(people: readonly Person[]): string {
  const names = people.map((p) => p.name)
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function describe(change: RoleChange, me: Person): string {
  const isMe = change.memberId === me.id
  const who = isMe ? 'You' : change.memberName
  const label = ROLE_LABELS[change.role]
  if (change.action === 'add') {
    const extra = change.role === 'president' && !isMe ? ' — including yours' : ''
    return `${who} ${isMe ? 'become' : 'becomes'} ${label} and ${GAINS[change.role]}${extra}.`
  }
  if (change.role === 'president' && isMe) {
    return 'You stop being President. You lose role management straight away and cannot give it back to yourself.'
  }
  return `${who} ${isMe ? 'are' : 'is'} no longer ${label} and ${LOSES[change.role]}.`
}

export function planRoleChanges(input: PlanInput): RolePlan {
  const { target, me, holders } = input
  const holds = (role: PrivilegedRole, id: string) => holders[role].some((p) => p.id === id)

  const current = PRIVILEGED_ROLES.filter((role) => holds(role, target.id))
  const desired = sortRoles(input.desired)
  const adds = desired.filter((role) => !current.includes(role))
  const removes = current.filter((role) => !desired.includes(role))

  const otherTreasurers = adds.includes('treasurer')
    ? holders.treasurer.filter((p) => p.id !== target.id)
    : []
  const canStepDown = adds.includes('president') && target.id !== me.id && holds('president', me.id)

  const changes: RoleChange[] = []
  const push = (person: Person, role: PrivilegedRole, action: RoleChange['action']) =>
    changes.push({ memberId: person.id, memberName: person.name, role, action })

  // Grants first: a hand-over adds the new holder before removing the old one.
  for (const role of adds) push(target, role, 'add')
  const removingOwnPresidency = target.id === me.id && removes.includes('president')
  for (const role of removes) {
    if (!(role === 'president' && target.id === me.id)) push(target, role, 'remove')
  }
  if (input.replaceTreasurer) for (const person of otherTreasurers) push(person, 'treasurer', 'remove')
  // Giving up your own presidency comes last — after it you can change nothing.
  if (removingOwnPresidency) push(me, 'president', 'remove')
  else if (canStepDown && input.stepDown) push(me, 'president', 'remove')

  // Who would hold President and Treasurer afterwards?
  const after = {
    president: new Set(holders.president.map((p) => p.id)),
    treasurer: new Set(holders.treasurer.map((p) => p.id)),
  }
  for (const change of changes) {
    if (change.role !== 'president' && change.role !== 'treasurer') continue
    if (change.action === 'add') after[change.role].add(change.memberId)
    else after[change.role].delete(change.memberId)
  }

  // The database refuses to remove the last President anyway (a trigger).
  // Saying so here, before anything is attempted, is kinder than an error.
  const removesPresident = changes.some((c) => c.role === 'president' && c.action === 'remove')
  const blocked =
    removesPresident && after.president.size === 0
      ? target.id === me.id
        ? 'You are the only President. Give President to someone else first, then remove your own.'
        : `${target.name} is the only President. Give President to someone else first — the club always needs one.`
      : null

  const consequences = changes.map((change) => describe(change, me))
  const removesTreasurer = changes.some((c) => c.role === 'treasurer' && c.action === 'remove')
  if (removesTreasurer && after.treasurer.size === 0) {
    consequences.push('Nobody will be able to change financial entries until someone is made Treasurer.')
  }

  return {
    changes,
    consequences,
    // President, Treasurer and Developer are the powerful ones: ask twice.
    // Developer is full access, so granting it deserves the same pause as
    // granting the presidency. Vice President changes save straight away.
    needsConfirmation: changes.some(
      (c) => c.role === 'president' || c.role === 'treasurer' || c.role === 'developer',
    ),
    blocked,
    otherTreasurers,
    canStepDown,
  }
}
