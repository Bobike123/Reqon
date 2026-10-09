import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { BackupsGuide } from './BackupsGuide.tsx'

// The guide is static text; these tests keep its structure, its two audiences and its facts from drifting.

describe('BackupsGuide', () => {
  it('is collapsed behind one summary line', () => {
    render(<BackupsGuide />)
    const guide = screen.getByTestId('backups-guide') as HTMLDetailsElement
    expect(guide.open).toBe(false)
    expect(screen.getByText('How backups work — step by step')).toBeInTheDocument()
  })

  it('shows the leaders tab by default and switches to the developer tab', async () => {
    const user = userEvent.setup()
    render(<BackupsGuide />)
    expect(screen.getByRole('tab', { name: 'President & Vice President' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('guide-leaders')).toBeInTheDocument()
    expect(screen.queryByTestId('guide-developer')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Developer' }))
    expect(screen.getByRole('tab', { name: 'Developer' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('guide-developer')).toBeInTheDocument()
    expect(screen.queryByTestId('guide-leaders')).not.toBeInTheDocument()
  })

  it('opens on the developer tab for a Developer', () => {
    render(<BackupsGuide defaultAudience="developer" />)
    expect(screen.getByRole('tab', { name: 'Developer' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Developer')
  })

  it('links each tab to its panel', () => {
    render(<BackupsGuide />)
    const tab = screen.getByRole('tab', { name: 'President & Vice President' })
    expect(tab).toHaveAttribute('aria-controls', screen.getByRole('tabpanel').id)
  })

  it('draws the three shared diagrams, each with a title', () => {
    render(<BackupsGuide />)
    const figures = screen.getAllByTestId('guide-diagram')
    // 3 shared + 1 for the leaders tab
    expect(figures).toHaveLength(4)
    expect(screen.getByText('1 · Every night at 03:17 UTC')).toBeInTheDocument()
    expect(screen.getByText('2 · Every Sunday, and on the 1st')).toBeInTheDocument()
    expect(screen.getByText('3 · Who can open a backup')).toBeInTheDocument()
    for (const f of figures) expect(f.querySelector('figcaption')?.textContent?.length).toBeGreaterThan(10)
  })

  it('hides the decorative arrows from assistive technology', () => {
    render(<BackupsGuide />)
    const arrows = screen.getAllByText('↓')
    expect(arrows.length).toBeGreaterThan(3)
    for (const a of arrows) expect(a).toHaveAttribute('aria-hidden', 'true')
  })

  it('states the real schedule and retention', () => {
    render(<BackupsGuide />)
    expect(screen.getAllByText(/03:17 UTC/).length).toBeGreaterThan(0)
    expect(screen.getByText('Folder daily/. Kept 35 days.')).toBeInTheDocument()
    expect(screen.getByText('Kept 26 weeks.')).toBeInTheDocument()
    expect(screen.getByText('Kept 24 months.')).toBeInTheDocument()
  })

  it('tells leaders what to do for each state, and never to fix it themselves', () => {
    render(<BackupsGuide />)
    const panel = screen.getByTestId('guide-leaders')
    expect(within(panel).getByText(/Backups are running/)).toBeInTheDocument()
    expect(within(panel).getByText(/The daily backup needs attention/)).toBeInTheDocument()
    expect(within(panel).getByText(/Do not try to fix it yourself/)).toBeInTheDocument()
    expect(within(panel).getByText(/Never ask anyone to send you a private key/)).toBeInTheDocument()
  })

  it('gives developers the exact commands', async () => {
    const user = userEvent.setup()
    render(<BackupsGuide />)
    await user.click(screen.getByRole('tab', { name: 'Developer' }))
    const panel = screen.getByTestId('guide-developer')
    for (const text of ['backup.yml', 'backup-freshness.yml', 'restore-drill.yml', 'verify.sh', 'restore.sh undo', '--exact', 'recipients.txt']) {
      expect(within(panel).getAllByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).length).toBeGreaterThan(0)
    }
  })

  it('never contains a secret-looking value', async () => {
    const user = userEvent.setup()
    const { container } = render(<BackupsGuide />)
    await user.click(screen.getByRole('tab', { name: 'Developer' }))
    expect(container.textContent).not.toMatch(/AGE-SECRET-KEY|BEGIN OPENSSH|GOCSPX|ya29\.|cfut_/)
  })
})
