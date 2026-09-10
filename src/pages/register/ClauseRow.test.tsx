import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Clause } from '../../data/useClauses.ts'
import type { Member } from '../../data/useMembers.ts'
import { ClauseRow } from './ClauseRow.tsx'
import type { RegisterRow } from './registerModel.ts'

const MEMBERS = [
  { id: 'm1', full_name: 'Ada Rider' },
  { id: 'm2', full_name: 'Bo Wrench' },
] as Member[]

function row(over: Partial<RegisterRow> & { key: string }): RegisterRow {
  return {
    clause: {
      clause_key: over.key,
      printed_ref: over.clause?.printed_ref ?? over.key,
      section: 'B',
      article: 2,
      article_title: null,
      group_title: null,
      subteam_key: 'GEOM',
      body: over.clause?.body ?? 'The fairing shall not exceed 600 mm.',
      obligation: over.clause?.obligation ?? 'constraint',
      criticality: over.clause?.criticality ?? 'required',
      phase: 'design',
      milestone_key: null,
      is_team_duty: true,
      specs: over.clause?.specs ?? null,
    } as Clause,
    status: null,
    state: over.state ?? 'open',
    ownerId: over.ownerId ?? null,
    starred: over.starred ?? false,
    evidence: over.evidence ?? null,
    isParked: over.isParked ?? false,
  }
}

function renderRow(r: RegisterRow) {
  const handlers = {
    onSetState: vi.fn(),
    onSetOwner: vi.fn(),
    onSetEvidence: vi.fn(),
    onToggleStar: vi.fn(),
  }
  render(<ClauseRow row={r} members={MEMBERS} {...handlers} />)
  return handlers
}

describe('editing a rule', () => {
  it('sends a status change keyed by clause_key, not printed_ref', async () => {
    const r = row({ key: 'F.5.2.3#2' })
    r.clause.printed_ref = 'F.5.2.3'
    const h = renderRow(r)

    await userEvent.selectOptions(screen.getByLabelText('Status for F.5.2.3'), 'compliant')
    // The write must address the clause by its unique key, even though two
    // different clauses print the same reference.
    expect(h.onSetState).toHaveBeenCalledWith('F.5.2.3#2', 'compliant')
  })

  it('sends an owner change, and null when cleared', async () => {
    const h = renderRow(row({ key: 'B.2.1.2', ownerId: 'm1' }))
    const owner = screen.getByLabelText('Owner for B.2.1.2')

    await userEvent.selectOptions(owner, 'm2')
    expect(h.onSetOwner).toHaveBeenCalledWith('B.2.1.2', 'm2')

    await userEvent.selectOptions(owner, '')
    expect(h.onSetOwner).toHaveBeenCalledWith('B.2.1.2', null)
  })

  it('saves evidence on blur, and not on every keystroke', async () => {
    const h = renderRow(row({ key: 'B.2.1.2' }))
    const field = screen.getByLabelText('Evidence for B.2.1.2')
    await userEvent.type(field, 'CAD-042')
    expect(h.onSetEvidence).not.toHaveBeenCalled()
    await userEvent.tab()
    expect(h.onSetEvidence).toHaveBeenCalledWith('B.2.1.2', 'CAD-042')
  })

  it('toggles the star', async () => {
    const h = renderRow(row({ key: 'B.2.1.2', starred: false }))
    const star = screen.getByRole('button', { name: 'Star B.2.1.2' })
    expect(star).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(star)
    expect(h.onToggleStar).toHaveBeenCalledWith('B.2.1.2', true)
  })
})

describe('presentation', () => {
  it('shows the printed reference, not the clause key', () => {
    const r = row({ key: 'E.5.4.5#2' })
    r.clause.printed_ref = 'E.5.4.5'
    renderRow(r)
    expect(screen.getByText('E.5.4.5')).toBeInTheDocument()
    expect(screen.queryByText('E.5.4.5#2')).not.toBeInTheDocument()
  })

  it('badges a blocking rule as NC risk', () => {
    const r = row({ key: 'B.1' })
    r.clause.criticality = 'blocking'
    renderRow(r)
    expect(screen.getByText('NC RISK')).toBeInTheDocument()
  })

  it('marks a parked rule visibly but keeps it fully editable', () => {
    renderRow(row({ key: 'G.1', isParked: true }))
    expect(screen.getByText(/PARKED/)).toBeInTheDocument()
    // De-emphasised, not disabled: the controls still work.
    expect(screen.getByLabelText('Status for G.1')).toBeEnabled()
  })

  it('renders extracted numeric specs', () => {
    const r = row({ key: 'B.2.1.2' })
    r.clause.specs = [{ op: 'min', unit: 'mm', value: 450 }]
    renderRow(r)
    expect(screen.getByText('≥ 450 mm')).toBeInTheDocument()
  })

  it('gives every control an accessible name', () => {
    renderRow(row({ key: 'B.9' }))
    expect(screen.getByLabelText('Status for B.9')).toBeInTheDocument()
    expect(screen.getByLabelText('Owner for B.9')).toBeInTheDocument()
    expect(screen.getByLabelText('Evidence for B.9')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Star B.9' })).toBeInTheDocument()
  })
})
