import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { permissionsFor, type PrivilegedRole } from '../auth/permissions.ts'
import { useTutorial } from './context.ts'
import { GUIDE_PARTS, TUTORIAL_STEPS, type TourViewer, type TutorialStep } from './steps.ts'
import { readTutorialRecord } from './storage.ts'
import { buildTour, tourMenu } from './tour.ts'
import { TutorialProvider } from './TutorialProvider.tsx'

// The Developer guide: a separate walk-through (backups, keys, loading a backup), offered only to a Developer,
// never part of the tour, and silent about the tour's own "seen it" record.

const { who } = vi.hoisted(() => ({ who: { roles: [] as string[] } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: { id: 'm1', full_name: 'Ada Rider' }, roles: who.roles }),
}))
vi.mock('../data/useTaskActor.ts', () => ({
  useTaskActor: () => ({ id: 'm1', status: 'active', isDeveloper: who.roles.includes('developer'), headOf: [] }),
}))

const viewerFor = (roles: PrivilegedRole[]): TourViewer => ({ ...permissionsFor(roles), isHeadOfDepartment: false })
const GUIDE = TUTORIAL_STEPS.filter((s) => s.guide)

describe('the real Developer guide: content', () => {
  it('has the four parts, each with steps, in order', () => {
    expect(GUIDE.length).toBeGreaterThanOrEqual(14)
    const seen = [...new Set(GUIDE.map((s) => s.chapter))]
    expect(seen).toEqual(GUIDE_PARTS.map((p) => p.id))
  })

  it('has unique ids and stays readable: a title and at most 700 characters of text per step', () => {
    expect(new Set(TUTORIAL_STEPS.map((s) => s.id)).size).toBe(TUTORIAL_STEPS.length)
    for (const step of GUIDE) {
      expect(step.title.length, step.id).toBeGreaterThan(0)
      expect(step.body.length, `${step.id} is too long`).toBeLessThanOrEqual(700)
      expect(step.audience, `${step.id} must not need another audience`).toBeUndefined()
    }
  })

  it('covers how it works, the keys, loading a backup and a data transfer', () => {
    const text = GUIDE.map((s) => `${s.title}\n${s.body}`).join('\n')
    for (const needle of [
      '03:17 UTC', 'backup_reader', 'age-keygen', 'recipients.txt', 'ATTACHMENTS_S3_', 'BACKUPS_R2_', 'DRILL_R2_',
      'PGPASSWORD', 'verify.sh', 'restore.sh plan', 'restore.sh apply', 'restore.sh undo', '--exact', 'db push --linked',
      'backup:test:local', 'restore:drill:local', 'HOSTED_SETUP.md', 'Moving data to another database',
    ]) {
      expect(text, needle).toContain(needle)
    }
  })

  it('shows commands as commands: every "$ " line holds a real command', () => {
    const commands = GUIDE.flatMap((s) => s.body.split('\n').filter((l) => l.startsWith('$ ')))
    expect(commands.length).toBeGreaterThanOrEqual(10)
    for (const c of commands) expect(c.length, c).toBeGreaterThan(8)
  })

  it('never contains a secret-looking value', () => {
    const text = GUIDE.map((s) => s.body).join('\n')
    expect(text).not.toMatch(/AGE-SECRET-KEY|BEGIN OPENSSH|GOCSPX|ya29\.|cfut_|age1[0-9a-z]{20,}/)
  })

  it('points only at things that exist on the Settings screen or nothing at all', () => {
    for (const step of GUIDE) {
      expect(step.route, step.id).toBe('/settings')
      if (step.target) expect(['settings-backups', 'backups-status', 'backups-copies', 'backups-guide', 'backups-download']).toContain(step.target)
    }
  })
})

describe('who is offered the Developer guide, and where it stays out', () => {
  it('is offered to a Developer only', () => {
    for (const roles of [[], ['president'], ['vicepresident'], ['treasurer'], ['documentation'], ['president', 'vicepresident']] as PrivilegedRole[][]) {
      expect(tourMenu(TUTORIAL_STEPS, viewerFor(roles)).developerGuide, roles.join()).toBeNull()
      expect(buildTour(TUTORIAL_STEPS, viewerFor(roles), { kind: 'guide' }), roles.join()).toEqual([])
    }
    const menu = tourMenu(TUTORIAL_STEPS, viewerFor(['developer']))
    expect(menu.developerGuide?.count).toBe(GUIDE.length)
    expect(menu.developerGuide?.parts.map((p) => p.id)).toEqual(GUIDE_PARTS.map((p) => p.id))
    expect(menu.developerGuide?.parts.reduce((n, p) => n + p.count, 0)).toBe(GUIDE.length)
  })

  it('is never part of the full tour, the role tour or a screen’s part, for anyone', () => {
    for (const roles of [[], ['president'], ['developer'], ['developer', 'president', 'vicepresident', 'treasurer']] as PrivilegedRole[][]) {
      const viewer = viewerFor(roles)
      const full = buildTour(TUTORIAL_STEPS, viewer, { kind: 'full' })
      const role = buildTour(TUTORIAL_STEPS, viewer, { kind: 'role' })
      const settings = buildTour(TUTORIAL_STEPS, viewer, { kind: 'chapter', chapter: 'settings' })
      for (const list of [full, role, settings]) expect(list.some((s) => s.guide), roles.join()).toBe(false)
    }
  })

  it('does not change what a Developer sees in the normal tour', () => {
    const withGuide = buildTour(TUTORIAL_STEPS, viewerFor(['developer']), { kind: 'full' }).map((s) => s.id)
    const without = buildTour(TUTORIAL_STEPS.filter((s) => !s.guide), viewerFor(['developer']), { kind: 'full' }).map((s) => s.id)
    expect(withGuide).toEqual(without)
  })

  it('runs one part on its own', () => {
    const keys = buildTour(TUTORIAL_STEPS, viewerFor(['developer']), { kind: 'guide', part: 'dev-keys' })
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every((s) => s.chapter === 'dev-keys')).toBe(true)
  })
})

describe('running the guide in the app', () => {
  const STEPS: TutorialStep[] = [
    { id: 'tour-1', chapter: 'start', title: 'Tour step', body: 'About the tour' },
    { id: 'g1', guide: 'developer', chapter: 'dev-how', title: 'Guide one', body: 'First line\n$ ops/backup/verify.sh a.tar.age key' },
    { id: 'g2', guide: 'developer', chapter: 'dev-keys', title: 'Guide two', body: 'Second' },
  ]
  function Controls() {
    const t = useTutorial()
    return (
      <>
        <button type="button" onClick={t.openChooser}>Choose tour</button>
        <button type="button" onClick={() => t.start({ kind: 'guide' })}>Start guide</button>
      </>
    )
  }
  const renderApp = () =>
    render(
      <MemoryRouter>
        <TutorialProvider steps={STEPS} searchTimeoutMs={50}>
          <Controls />
        </TutorialProvider>
      </MemoryRouter>,
    )

  beforeEach(() => {
    who.roles = ['developer']
    window.localStorage.clear()
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ x: 0, y: 0, top: 0, left: 0, width: 100, height: 40, right: 100, bottom: 40, toJSON: () => ({}) }) as DOMRect,
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('adds a separate Developer guide section to the chooser, for a Developer', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: 'Choose tour' }))
    const section = await screen.findByTestId('developer-guide')
    expect(within(section).getByRole('heading', { name: 'Developer guide' })).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: /whole guide.*2 steps/i })).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: /^How the backups work\s*1 step$/ })).toBeInTheDocument()
  })

  it('does not show it to anyone else', async () => {
    who.roles = ['president']
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: 'Choose tour' }))
    await screen.findByRole('dialog', { name: 'Guided tour' })
    expect(screen.queryByTestId('developer-guide')).not.toBeInTheDocument()
  })

  it('shows a command as a command and labels the card, and the tour offer is left alone afterwards', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: 'Choose tour' }))
    await user.click(await screen.findByRole('button', { name: /whole guide/i }))
    const card = await screen.findByRole('dialog', { name: 'Guide one' })
    expect(within(card).getByText('Developer guide')).toBeInTheDocument()
    expect(within(card).getByText('First line')).toBeInTheDocument()
    const cmd = within(card).getByText('$ ops/backup/verify.sh a.tar.age key')
    expect(cmd.tagName).toBe('CODE')
    await user.click(within(card).getByRole('button', { name: 'Next' }))
    await user.click(await screen.findByRole('button', { name: 'Finish' }))
    expect(screen.queryByTestId('tutorial-card')).not.toBeInTheDocument()
    // Finishing the guide says nothing about the first-visit tour.
    expect(readTutorialRecord()).toBeNull()
    expect(screen.getByText('New to Reqon?')).toBeInTheDocument()
  })

  it('leaving the guide with Skip does not dismiss the tour offer either', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: 'Start guide' }))
    await user.click(await screen.findByRole('button', { name: 'Skip tutorial' }))
    expect(readTutorialRecord()).toBeNull()
  })

  it('does nothing for someone who is not a Developer', async () => {
    who.roles = []
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: 'Start guide' }))
    expect(screen.queryByTestId('tutorial-card')).not.toBeInTheDocument()
  })
})
