import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { signOut, who } = vi.hoisted(() => ({ signOut: vi.fn(), who: { roles: [] as string[] } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: { id: 'm1', full_name: 'Ada Rider' }, roles: who.roles, signOut }),
}))
vi.mock('../data/useCurrentSeason.ts', () => ({
  useCurrentSeason: () => ({ data: { id: 's1', label: '2026/27' } }),
}))

const { AppHeader } = await import('./AppHeader.tsx')
const { TutorialProvider } = await import('../tutorial/TutorialProvider.tsx')

function renderHeader(path = '/register') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TutorialProvider steps={[{ id: 'only', chapter: 'start', target: 'help-button', title: 'Restart here', body: 'Body' }]}>
        <AppHeader />
        <Routes>
          <Route path="*" element={<main id="main-content">page</main>} />
        </Routes>
      </TutorialProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  signOut.mockClear()
  who.roles = []
  window.localStorage.setItem('reqon.tutorial.v2', 'completed')
})

const desktopNav = () => screen.getAllByRole('navigation', { name: 'Main' })[0]

describe('main navigation', () => {
  it('lists every screen, in the order the build brief gives them', () => {
    renderHeader()
    const labels = within(desktopNav()).getAllByRole('link').map((a) => a.textContent)
    // Proposals and Meetings are two screens: the old "Meetings" was neither.
    expect(labels).toEqual([
      'Now', 'Priorities', 'Register', 'Milestones', 'Board', 'Proposals', 'Meetings', 'Spec sheet', 'Settings',
    ])
  })

  it('makes Settings reachable — before this it had no link from anywhere', () => {
    renderHeader()
    expect(within(desktopNav()).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
  })

  it('shows where you are with aria-current, not colour alone', () => {
    renderHeader('/register')
    expect(within(desktopNav()).getByRole('link', { name: 'Register' })).toHaveAttribute('aria-current', 'page')
    expect(within(desktopNav()).getByRole('link', { name: 'Now' })).not.toHaveAttribute('aria-current')
  })

  it('shows which season everything belongs to', () => {
    renderHeader()
    expect(screen.getByText('2026/27')).toBeInTheDocument()
  })

  it('offers sign-out from every screen', async () => {
    const user = userEvent.setup()
    renderHeader('/board')
    await user.click(screen.getAllByRole('button', { name: 'Sign out' })[0])
    expect(signOut).toHaveBeenCalledOnce()
  })
})

describe('phone menu', () => {
  it('opens, closes with Escape and hands focus back to the Menu button', async () => {
    const user = userEvent.setup()
    renderHeader()
    const menu = screen.getByRole('button', { name: 'Menu' })
    expect(menu).toHaveAttribute('aria-expanded', 'false')
    await user.click(menu)
    const toggle = screen.getByRole('button', { name: 'Close' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAttribute('aria-controls', 'phone-menu')
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(2)
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus()
  })

  it('closes when you choose a screen', async () => {
    const user = userEvent.setup()
    renderHeader('/register')
    await user.click(screen.getByRole('button', { name: 'Menu' }))
    const phoneNav = screen.getAllByRole('navigation', { name: 'Main' })[1]
    await user.click(within(phoneNav).getByRole('link', { name: 'Board' }))
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('does not point aria-controls at an element that is not there', () => {
    renderHeader()
    expect(screen.getByRole('button', { name: 'Menu' })).not.toHaveAttribute('aria-controls')
  })
})

describe('tutorial entry point', () => {
  it('opens the tour chooser from the header, and the full tour starts from there', async () => {
    const user = userEvent.setup()
    renderHeader()
    await user.click(screen.getAllByRole('button', { name: 'Tutorial' })[0])
    const chooser = await screen.findByRole('dialog', { name: 'Guided tour' })
    await user.click(within(chooser).getByRole('button', { name: /^Full tour/ }))
    expect(await screen.findByRole('dialog', { name: 'Restart here' })).toBeInTheDocument()
  })

  it('from the phone menu, closes the menu and keeps focus on the Menu button', async () => {
    const user = userEvent.setup()
    renderHeader()
    await user.click(screen.getByRole('button', { name: 'Menu' }))
    const phoneTutorial = screen.getAllByRole('button', { name: 'Tutorial' })[1]
    await user.click(phoneTutorial)
    expect(await screen.findByRole('dialog', { name: 'Guided tour' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('permission-aware navigation', () => {
  it('offers Finances only to the roles that can see money', () => {
    for (const roles of [['president'], ['vicepresident'], ['treasurer'], ['developer']]) {
      who.roles = roles
      const { unmount } = renderHeader()
      expect(within(desktopNav()).getByRole('link', { name: 'Finances' })).toHaveAttribute('href', '/finances')
      unmount()
    }
    // An ordinary member could see nothing there, so there is no dead link.
    who.roles = []
    renderHeader()
    expect(within(desktopNav()).queryByRole('link', { name: 'Finances' })).not.toBeInTheDocument()
  })

  it('shows your roles beside your name, in words', () => {
    who.roles = ['developer', 'treasurer']
    renderHeader()
    expect(screen.getByText(/· Treasurer, Developer/)).toBeInTheDocument()
  })
})
