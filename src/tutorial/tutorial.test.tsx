import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTutorial } from './context.ts'
import { TUTORIAL_STEPS, type TutorialStep } from './steps.ts'
import { readTutorialRecord } from './storage.ts'
import { TutorialProvider } from './TutorialProvider.tsx'

const STEPS: TutorialStep[] = [
  { id: 'one', route: '/a', target: 'target-a', title: 'Step A', body: 'About A' },
  { id: 'two', route: '/b', target: 'target-b', title: 'Step B', body: 'About B' },
  { id: 'gone', target: 'does-not-exist', title: 'Missing step', body: 'Not on screen' },
]
const saveSomething = vi.fn()

function StartButton() {
  const tutorial = useTutorial()
  return <button type="button" onClick={tutorial.start}>Start tour</button>
}
function WhereAmI() {
  return <p data-testid="path">{useLocation().pathname}</p>
}

function renderTour(initial = '/a') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <TutorialProvider steps={STEPS} searchTimeoutMs={150}>
        <StartButton />
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

beforeEach(() => {
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
    expect(screen.getByText('New to Paddock Control?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('New to Paddock Control?')).not.toBeInTheDocument()
    expect(readTutorialRecord()).toBe('dismissed')
    first.unmount()
    renderTour()
    expect(screen.queryByText('New to Paddock Control?')).not.toBeInTheDocument()
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
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(readTutorialRecord()).toBe('completed')
    expect(screen.queryByText('New to Paddock Control?')).not.toBeInTheDocument()
  })

  it('Skip leaves at once and gives focus back to where you were', async () => {
    const user = userEvent.setup()
    renderTour()
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    await screen.findByRole('dialog', { name: 'Step A' })
    await user.click(screen.getByRole('button', { name: 'Skip tutorial' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(readTutorialRecord()).toBe('dismissed')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start tour' })).toHaveFocus())
  })

  it('Escape leaves the tour', async () => {
    const user = userEvent.setup()
    renderTour()
    await user.click(screen.getByRole('button', { name: 'Start tour' }))
    await screen.findByRole('dialog', { name: 'Step A' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
      const found =
        app.includes(`"${step.target}"`) ||
        app.includes(`'${step.target}'`) ||
        new RegExp(`data-tutorial="[^"]*\\b${step.target}\\b`).test(app)
      expect(found, `step "${step.id}" targets data-tutorial="${step.target}", which no screen renders`).toBe(true)
    }
  })

  it('is short enough to finish, and every step says something', () => {
    expect(TUTORIAL_STEPS.length).toBeGreaterThanOrEqual(10)
    expect(TUTORIAL_STEPS.length).toBeLessThanOrEqual(14)
    for (const step of TUTORIAL_STEPS) {
      expect(step.title.length).toBeGreaterThan(0)
      expect(step.body.length, `step ${step.id} is too long to read in a small card`).toBeLessThan(240)
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
