import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { permissionsFor, type PrivilegedRole } from '../auth/permissions.ts'
import { NAV_ITEMS } from '../ui/navItems.ts'
import { useTutorial } from './context.ts'
import { CHAPTERS, TUTORIAL_STEPS, type TutorialStep } from './steps.ts'
import { readTutorialRecord } from './storage.ts'
import { buildTour, tourMenu } from './tour.ts'
import { TutorialProvider } from './TutorialProvider.tsx'

// Who is signed in. Which steps the tour shows follows from these roles.
const { who } = vi.hoisted(() => ({ who: { roles: [] as string[] } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({
    status: 'member',
    user: { id: 'm1' },
    member: { id: 'm1', full_name: 'Ada Rider' },
    roles: who.roles,
  }),
}))

const STEPS: TutorialStep[] = [
  { id: 'one', chapter: 'start', route: '/a', target: 'target-a', title: 'Step A', body: 'About A' },
  { id: 'two', chapter: 'board', route: '/b', target: 'target-b', title: 'Step B', body: 'About B' },
  {
    id: 'money',
    chapter: 'finances',
    route: '/b',
    target: 'target-b',
    audience: 'treasurer',
    title: 'Treasurer step',
    body: 'Only for the Treasurer',
  },
  { id: 'gone', chapter: 'end', target: 'does-not-exist', title: 'Missing step', body: 'Not on screen' },
]
const saveSomething = vi.fn()

function Controls() {
  const tutorial = useTutorial()
  return (
    <>
      <button type="button" onClick={() => tutorial.start()}>
        Start tour
      </button>
      <button type="button" onClick={tutorial.openChooser}>
        Choose tour
      </button>
    </>
  )
}
function WhereAmI() {
  return <p data-testid="path">{useLocation().pathname}</p>
}

function renderTour(initial = '/a', steps = STEPS) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <TutorialProvider steps={steps} searchTimeoutMs={150}>
        <Controls />
        <WhereAmI />
        <Routes>
          <Route
            path="/a"
            element={
              <div data-tutorial="target-a">
                Screen A <button type="button" onClick={saveSomething}>Save a change</button>
              </div>
            }
          />
          <Route path="/b" element={<div data-tutorial="target-b">Screen B</div>} />
        </Routes>
      </TutorialProvider>
    </MemoryRouter>,
  )
}

const card = () => screen.queryByTestId('tutorial-card')

beforeEach(() => {
  who.roles = []
  window.localStorage.clear()
  saveSomething.mockClear()
  // jsdom lays nothing out; give every element a real-looking box.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ x: 20, y: 40, top: 40, left: 20, width: 200, height: 60, right: 220, bottom: 100, toJSON: () => ({}) }) as DOMRect,
  )
})
afterEach(() => vi.restoreAllMocks())

describe('first visit', () => {
  it('offers the tour once, and "Not now" means not again', async () => {
    const user = userEvent.setup()
    const first = renderTour()
    expect(screen.getByText('New to Reqon?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('New to Reqon?')).not.toBeInTheDocument()
    expect(readTutorialRecord()).toBe('dismissed')
    first.unmount()
    renderTour()
    expect(screen.queryByText('New to Reqon?')).not.toBeInTheDocument()
  })

  it('tells someone with a role that their parts are included', () => {
    who.roles = ['treasurer']
    renderTour()
    expect(screen.getByTestId('tutorial-offer')).toHaveTextContent('plus the parts for your role (Treasurer)')
  })
})

describe('running the tour over the real screen', () => {
  it('opens the step, highlights the real control and shows progress', async () => {
    const user = userEvent.setup()
    renderTour('/b')
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    expect(await screen.findByRole('dialog', { name: 'Step A' })).toBeInTheDocument()
    expect(screen.getByTestId('path')).toHaveTextContent('/a')
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('tutorial-spotlight').style.display).toBe('block'))
  })

  it('Next and Back move between steps and between screens', async () => {
    const user = userEvent.setup()
    renderTour()
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    await screen.findByRole('dialog', { name: 'Step A' })
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('dialog', { name: 'Step B' })).toBeInTheDocument()
    expect(screen.getByTestId('path')).toHaveTextContent('/b')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('dialog', { name: 'Step A' })).toBeInTheDocument()
    expect(screen.getByTestId('path')).toHaveTextContent('/a')
  })

  it('Back is unavailable on the first step', async () => {
    const user = userEvent.setup()
    renderTour()
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    await screen.findByRole('dialog', { name: 'Step A' })
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  })

  it('skips steps meant for a role you do not have', async () => {
    const user = userEvent.setup()
    renderTour()
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    await screen.findByRole('dialog', { name: 'Step A' })
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('dialog', { name: 'Step B' })
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('dialog', { name: 'Missing step' })).toBeInTheDocument()
    expect(screen.queryByText('Treasurer step')).not.toBeInTheDocument()
  })

  it('puts a step with nothing to point at in the middle, with no warning', async () => {
    const user = userEvent.setup()
    renderTour('/a', [{ id: 'hello', chapter: 'start', title: 'Hello', body: 'Welcome' }])
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    expect(await screen.findByRole('dialog', { name: 'Hello' })).toBeInTheDocument()
    expect(screen.getByTestId('tutorial-spotlight').style.display).toBe('none')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(screen.queryByText(/isn’t showing right now/)).not.toBeInTheDocument()
  })
})

describe('when a highlighted control is missing', () => {
  it('shows a safe fallback instead of crashing or dimming forever', async () => {
    const user = userEvent.setup()
    renderTour()
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    await screen.findByRole('dialog', { name: 'Step A' })
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByRole('dialog', { name: 'Step B' })
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('dialog', { name: 'Missing step' })).toBeInTheDocument()
    expect(await screen.findByText(/isn’t showing right now/)).toBeInTheDocument()
    expect(screen.getByTestId('tutorial-spotlight').style.display).toBe('none')

    await user.click(screen.getByRole('button', { name: 'Finish' }))
    expect(card()).not.toBeInTheDocument()
    expect(screen.queryByTestId('tutorial-blocker')).not.toBeInTheDocument()
  })
})

describe('leaving the tour', () => {
  it('Finish records completion, clears the overlay, and the offer stays away', async () => {
    const user = userEvent.setup()
    renderTour()
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    await screen.findByRole('dialog', { name: 'Step A' })
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await user.click(await screen.findByRole('button', { name: 'Finish' }))
    expect(card()).not.toBeInTheDocument()
    expect(readTutorialRecord()).toBe('completed')
    expect(screen.queryByText('New to Reqon?')).not.toBeInTheDocument()
  })

  it('Skip leaves at once and gives focus back to where you were', async () => {
    const user = userEvent.setup()
    renderTour()
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    await screen.findByRole('dialog', { name: 'Step A' })
    await user.click(screen.getByRole('button', { name: 'Skip tutorial' }))
    expect(card()).not.toBeInTheDocument()
    expect(readTutorialRecord()).toBe('dismissed')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start tour' })).toHaveFocus())
  })

  it('Escape leaves the tour', async () => {
    const user = userEvent.setup()
    renderTour()
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    await screen.findByRole('dialog', { name: 'Step A' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(card()).not.toBeInTheDocument()
  })

  it('can be restarted after finishing', async () => {
    const user = userEvent.setup()
    renderTour()
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    await screen.findByRole('dialog', { name: 'Step A' })
    await user.click(screen.getByRole('button', { name: 'Skip tutorial' }))
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    expect(await screen.findByRole('dialog', { name: 'Step A' })).toBeInTheDocument()
  })
})

describe('the tour chooser', () => {
  async function openChooser(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Choose tour' }))
    return screen.findByRole('dialog', { name: 'Guided tour' })
  }

  it('offers the whole tour and each screen on its own, with their length', async () => {
    const user = userEvent.setup()
    renderTour()
    const chooser = await openChooser(user)
    expect(within(chooser).getByRole('button', { name: /^Full tour.*3 steps$/ })).toBeInTheDocument()
    expect(within(chooser).getByRole('button', { name: /^Getting started\s*1 step$/ })).toBeInTheDocument()
    expect(within(chooser).getByRole('button', { name: /^Board\s*1 step$/ })).toBeInTheDocument()
    // A member has no role parts, and is never offered the Finances part.
    expect(within(chooser).queryByRole('button', { name: /^Only the/ })).not.toBeInTheDocument()
    expect(within(chooser).queryByRole('button', { name: /^Finances/ })).not.toBeInTheDocument()
  })

  it('runs only the screen you pick', async () => {
    const user = userEvent.setup()
    renderTour('/a')
    const chooser = await openChooser(user)
    await user.click(within(chooser).getByRole('button', { name: /^Board/ }))
    expect(await screen.findByRole('dialog', { name: 'Step B' })).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 1')).toBeInTheDocument()
    expect(screen.getByTestId('path')).toHaveTextContent('/b')
  })

  it('gives a Treasurer the Treasurer parts on their own, labelled as such', async () => {
    who.roles = ['treasurer']
    const user = userEvent.setup()
    renderTour()
    const chooser = await openChooser(user)
    expect(within(chooser).getByRole('button', { name: /^Full tour.*4 steps$/ })).toBeInTheDocument()
    await user.click(within(chooser).getByRole('button', { name: /^Only the Treasurer parts.*2 steps$/ }))
    expect(await screen.findByRole('dialog', { name: 'Treasurer step' })).toBeInTheDocument()
    expect(screen.getByText('Only for: Treasurer and Developer')).toBeInTheDocument()
  })

  it('Close leaves without starting anything', async () => {
    const user = userEvent.setup()
    renderTour()
    const chooser = await openChooser(user)
    await user.click(within(chooser).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: 'Guided tour' })).not.toBeInTheDocument()
    expect(card()).not.toBeInTheDocument()
  })
})

describe('keyboard and screen readers', () => {
  it('moves focus to the explanation and keeps Tab inside the card', async () => {
    const user = userEvent.setup()
    renderTour()
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    const dialog = await screen.findByRole('dialog', { name: 'Step A' })
    await waitFor(() => expect(dialog).toHaveFocus())
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('About A')
    for (let i = 0; i < 5; i += 1) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })
})

describe('the tour never changes data', () => {
  it('covers the page with a layer that takes the clicks, and keeps focus off the page', async () => {
    const user = userEvent.setup()
    renderTour()
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    const dialog = await screen.findByRole('dialog', { name: 'Step A' })
    expect(screen.getByTestId('tutorial-blocker')).toHaveClass('fixed', 'inset-0')
    for (let i = 0; i < 6; i += 1) {
      await user.tab()
      expect(screen.getByRole('button', { name: 'Save a change' })).not.toHaveFocus()
    }
    expect(dialog).toBeInTheDocument()
    expect(saveSomething).not.toHaveBeenCalled()
  })
})

// What each role is taught, on the REAL tour. Pure: no rendering needed.
const ids = (roles: PrivilegedRole[], kind: 'full' | 'role' = 'full') =>
  buildTour(TUTORIAL_STEPS, permissionsFor(roles), { kind }).map((s) => s.id)

describe('what each role is taught', () => {
  it('members get every screen in depth, and nothing that needs a role', () => {
    const steps = buildTour(TUTORIAL_STEPS, permissionsFor([]), { kind: 'full' })
    expect(steps.length).toBeGreaterThanOrEqual(30)
    expect(steps.filter((s) => s.audience)).toEqual([])
    const chapters = new Set(steps.map((s) => s.chapter))
    for (const chapter of CHAPTERS) {
      expect(chapters.has(chapter.id), chapter.id).toBe(chapter.id !== 'finances')
    }
    expect(tourMenu(TUTORIAL_STEPS, permissionsFor([])).role).toBeNull()
  })

  it('the Treasurer also learns to add, correct and hand over the money', () => {
    expect(ids(['treasurer'], 'role')).toEqual([
      'finance-access',
      'finance-totals',
      'finance-add',
      'finance-edit',
      'finance-handover',
      'finish',
    ])
    const all = ids(['treasurer'])
    for (const id of ['finance-read-only', 'change-roles', 'add-member', 'developer-scope']) {
      expect(all, id).not.toContain(id)
    }
  })

  it('the President also learns roles and how to run Settings', () => {
    const all = ids(['president'])
    expect(all).toEqual(
      expect.arrayContaining([
        'change-roles',
        'role-rules',
        'role-hand-over',
        'roster-controls',
        'add-member',
        'settings-subsystems',
        'settings-milestones',
        'new-season',
        'finance-read-only',
      ]),
    )
    for (const id of ['vp-roles', 'finance-add', 'developer-scope']) expect(all, id).not.toContain(id)
  })

  it('the Vice President learns Settings, and that roles are the President’s', () => {
    const all = ids(['vicepresident'])
    expect(all).toEqual(expect.arrayContaining(['vp-roles', 'roster-controls', 'add-member', 'new-season', 'finance-read-only']))
    for (const id of ['change-roles', 'role-rules', 'role-hand-over', 'finance-add']) {
      expect(all, id).not.toContain(id)
    }
  })

  it('the Developer is taught everything, because they can do everything', () => {
    const all = ids(['developer'])
    expect(all).toEqual(
      expect.arrayContaining([
        'developer-scope',
        'change-roles',
        'role-rules',
        'roster-controls',
        'add-member',
        'new-season',
        'finance-add',
        'finance-edit',
      ]),
    )
    // Nothing that tells them they cannot change something.
    expect(all).not.toContain('finance-read-only')
    expect(all).not.toContain('vp-roles')
  })

  it('never tells someone with two roles two contradicting things', () => {
    const all = ids(['treasurer', 'developer'])
    expect(all).toContain('finance-add')
    // Says "only the Treasurer may write", which is untrue for a Developer.
    expect(all).not.toContain('finance-read-only')
  })

  it('offers the Finances part only to people who can see finances', () => {
    expect(tourMenu(TUTORIAL_STEPS, permissionsFor([])).chapters.map((c) => c.id)).not.toContain('finances')
    for (const role of ['president', 'vicepresident', 'treasurer', 'developer'] as const) {
      expect(tourMenu(TUTORIAL_STEPS, permissionsFor([role])).chapters.map((c) => c.id), role).toContain('finances')
    }
  })
})

// Every step of the REAL tour must point at an attribute some screen renders.
// Renaming data-tutorial="register-row" without updating steps.ts fails here,
// instead of silently showing the "isn't showing" fallback to a new member.
const sources = import.meta.glob<string>('../**/*.tsx', { query: '?raw', import: 'default', eager: true })

describe('the real tour', () => {
  it('points every step at a data-tutorial target that exists in the app', () => {
    const app = Object.entries(sources)
      .filter(([path]) => !path.endsWith('.test.tsx'))
      .map(([, source]) => source)
      .join('\n')
    for (const step of TUTORIAL_STEPS) {
      if (!step.target) continue
      const found =
        app.includes(`"${step.target}"`) ||
        app.includes(`'${step.target}'`) ||
        new RegExp(`data-tutorial="[^"]*\\b${step.target}\\b`).test(app)
      expect(found, `step "${step.id}" targets data-tutorial="${step.target}", which no screen renders`).toBe(true)
    }
  })

  it('visits every screen in the menu', () => {
    for (const item of NAV_ITEMS) {
      expect(TUTORIAL_STEPS.some((s) => s.route === item.to), item.label).toBe(true)
    }
  })

  it('keeps every step short enough to read in a small card', () => {
    expect(new Set(TUTORIAL_STEPS.map((s) => s.id)).size).toBe(TUTORIAL_STEPS.length)
    for (const step of TUTORIAL_STEPS) {
      expect(step.title.length).toBeGreaterThan(0)
      expect(step.body.length, `step ${step.id} is too long to read in a small card`).toBeLessThan(240)
    }
  })

  it('keeps each screen’s part short enough to take on its own', () => {
    for (const chapter of CHAPTERS) {
      expect(TUTORIAL_STEPS.filter((s) => s.chapter === chapter.id).length, chapter.id).toBeLessThanOrEqual(16)
    }
  })

  it('explains that the team-duty filter hides rules that ask nothing of the team', () => {
    const filters = TUTORIAL_STEPS.find((s) => s.target === 'register-filters')
    expect(filters?.body).toMatch(/Team duties only/)
    expect(filters?.body).toMatch(/hides/)
  })

  it('never implies pass/fail is typed in by hand', () => {
    const spec = TUTORIAL_STEPS.find((s) => s.target === 'spec-row')
    expect(spec?.body).toMatch(/Nobody types pass or fail by hand/)
  })
})
