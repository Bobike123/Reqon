import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { Clause } from '../../data/useClauses.ts'
import type { Member } from '../../data/useMembers.ts'
import { ClauseRow } from './ClauseRow.tsx'
import { indexLinkedWork, linkedWorkFor, type LinkedTask, type LinkedWork } from './linkedWork.ts'
import type { RegisterRow } from './registerModel.ts'

const MEMBERS = [
  { id: 'm1', full_name: 'Ada Rider', status: 'active' },
  { id: 'm2', full_name: 'Bo Wrench', status: 'active' },
  { id: 'm3', full_name: 'Cy Retired', status: 'alumni' },
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

const NAMES = new Map([['m1', 'Ada Rider'], ['m3', 'Cy Retired']])
const DEPARTMENTS = new Map([['GEOM', 'Design Envelope']])
const NO_WORK = linkedWorkFor(new Map(), 'none')

type RenderOptions = {
  work?: LinkedWork
  availability?: 'ready' | 'loading' | 'unavailable'
  seasonRegsRef?: string | null
}

function renderRow(r: RegisterRow, options: RenderOptions = {}) {
  const handlers = {
    onSetState: vi.fn(),
    onSetOwner: vi.fn(),
    onSetEvidence: vi.fn(),
    onToggleStar: vi.fn(),
  }
  render(
    <MemoryRouter>
      <ClauseRow
        row={r}
        members={MEMBERS}
        work={options.work ?? NO_WORK}
        linkAvailability={options.availability ?? 'ready'}
        seasonRegsRef={options.seasonRegsRef === undefined ? 'ED1' : options.seasonRegsRef}
        memberNames={NAMES}
        departmentNames={DEPARTMENTS}
        {...handlers}
      />
    </MemoryRouter>,
  )
  return handlers
}

function task(id: string, over: Partial<LinkedTask> = {}): LinkedTask {
  return {
    id,
    title: `Task ${id}`,
    state: 'todo',
    priority: 'normal',
    owner_id: null,
    subteam_key: null,
    archived_at: null,
    ...over,
  }
}

function workFor(clauseKey: string, tasks: LinkedTask[], links: [string, string][] = tasks.map((t) => [t.id, clauseKey])) {
  return linkedWorkFor(
    indexLinkedWork(
      links.map(([task_id, clause_key]) => ({ task_id, clause_key })),
      tasks,
    ),
    clauseKey,
  )
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

  it('offers only active members as a new owner, and keeps a retired current owner visible and marked', () => {
    renderRow(row({ key: 'B.2.1.2', ownerId: 'm3' }))
    const options = within(screen.getByLabelText('Owner for B.2.1.2')).getAllByRole('option').map((o) => o.textContent)
    expect(options).toEqual(['Unassigned', 'Ada Rider', 'Bo Wrench', 'Cy Retired (no longer active)'])
    expect(screen.getByLabelText('Owner for B.2.1.2')).toHaveValue('m3')
  })

  it('does not offer a retired member when they are not the current owner', () => {
    renderRow(row({ key: 'B.2.1.2' }))
    const options = within(screen.getByLabelText('Owner for B.2.1.2')).getAllByRole('option').map((o) => o.textContent)
    expect(options).not.toContain('Cy Retired')
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

describe('linked work', () => {
  it('says "No linked work" when nothing is linked, never 0% or 100%', () => {
    renderRow(row({ key: 'B.1' }))
    expect(screen.getByTestId('link-progress')).toHaveTextContent('No linked work')
    expect(screen.queryByRole('button', { name: /show tasks/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /mark compliant/i })).not.toBeInTheDocument()
  })

  it('shows n / m done and expands into the tasks, each linking to the Board card', async () => {
    const work = workFor('B.1', [
      task('a', { state: 'done', owner_id: 'm1', subteam_key: 'GEOM' }),
      task('b', { state: 'wip', priority: 'urgent' }),
    ])
    renderRow(row({ key: 'B.1' }), { work })
    expect(screen.getByTestId('link-progress')).toHaveTextContent('1 / 2 linked tasks done')

    const toggle = screen.getByRole('button', { name: /show tasks \(2\)/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    const list = screen.getByTestId('linked-tasks')
    expect(within(list).getByRole('link', { name: 'Task a' })).toHaveAttribute('href', '/board?task=a')
    expect(within(list).getByText('Ada Rider', { exact: false })).toBeInTheDocument()
    expect(within(list).getByText('Design Envelope', { exact: false })).toBeInTheDocument()
    expect(within(list).getByText('Urgent')).toBeInTheDocument()
    expect(within(list).getByText('Unassigned', { exact: false })).toBeInTheDocument()
  })

  it('counts a task once even when it satisfies several requirements', () => {
    const shared = task('s', { state: 'done' })
    const index = indexLinkedWork(
      [
        { task_id: 's', clause_key: 'B.1' },
        { task_id: 's', clause_key: 'B.2' },
        { task_id: 's', clause_key: 'B.2' },
      ],
      [shared],
    )
    expect(linkedWorkFor(index, 'B.1').progress).toMatchObject({ done: 1, total: 1 })
    expect(linkedWorkFor(index, 'B.2').progress).toMatchObject({ done: 1, total: 1 })
  })

  it('keeps clauses that print the same reference separate, by clause_key', async () => {
    const index = indexLinkedWork(
      [
        { task_id: 'a', clause_key: 'F.5.2.3' },
        { task_id: 'b', clause_key: 'F.5.2.3#2' },
        { task_id: 'c', clause_key: 'F.5.2.3#2' },
      ],
      [task('a', { state: 'done' }), task('b'), task('c')],
    )
    expect(linkedWorkFor(index, 'F.5.2.3').tasks.map((t) => t.id)).toEqual(['a'])
    expect(linkedWorkFor(index, 'F.5.2.3#2').tasks.map((t) => t.id)).toEqual(['b', 'c'])

    const second = row({ key: 'F.5.2.3#2' })
    second.clause.printed_ref = 'F.5.2.3'
    renderRow(second, { work: linkedWorkFor(index, 'F.5.2.3#2') })
    // The row that owns the second clause shows ITS two tasks, not the first clause's one.
    expect(screen.getByTestId('link-progress')).toHaveTextContent('0 / 2 linked tasks done')
    expect(screen.getByTestId('linked-work-F.5.2.3#2')).toBeInTheDocument()
  })

  it('leaves cancelled tasks out of the count but still lists them', async () => {
    const work = workFor('B.1', [task('a', { state: 'done' }), task('c', { state: 'cancelled' })])
    renderRow(row({ key: 'B.1' }), { work })
    expect(screen.getByTestId('link-progress')).toHaveTextContent('1 / 1 linked task done')
    expect(screen.getByTestId('link-detail')).toHaveTextContent('1 cancelled, not counted')
    await userEvent.click(screen.getByRole('button', { name: /show tasks \(2\)/i }))
    expect(screen.getByRole('link', { name: 'Task c' })).toBeInTheDocument()
  })

  it('counts an archived Done task as done, and links it to the Archive', async () => {
    const work = workFor('B.1', [task('d', { state: 'done', archived_at: '2026-09-01T00:00:00Z' }), task('e')])
    renderRow(row({ key: 'B.1' }), { work })
    expect(screen.getByTestId('link-progress')).toHaveTextContent('1 / 2 linked tasks done')
    await userEvent.click(screen.getByRole('button', { name: /show tasks/i }))
    expect(screen.getByRole('link', { name: 'Task d' })).toHaveAttribute('href', '/archive?tab=tasks&id=d')
    expect(screen.getByText('Archived, done')).toBeInTheDocument()
  })

  it('identifies an archived task that never finished, and keeps it in the denominator', async () => {
    const work = workFor('B.1', [task('a', { state: 'done' }), task('u', { state: 'wip', archived_at: '2026-09-01T00:00:00Z' })])
    renderRow(row({ key: 'B.1' }), { work })
    expect(screen.getByTestId('link-progress')).toHaveTextContent('1 / 2 linked tasks done')
    expect(screen.getByTestId('link-detail')).toHaveTextContent('archived before finishing')
    await userEvent.click(screen.getByRole('button', { name: /show tasks/i }))
    expect(screen.getByText('Archived, not finished')).toBeInTheDocument()
  })

  it('does not call a linked-work list "no work" while it is loading or when it failed', () => {
    renderRow(row({ key: 'B.1' }), { availability: 'loading' })
    expect(screen.getByText('Loading linked work…')).toBeInTheDocument()
    expect(screen.queryByText('No linked work')).not.toBeInTheDocument()
  })

  it('says so when the linked work could not be loaded', () => {
    renderRow(row({ key: 'B.1' }), { availability: 'unavailable' })
    expect(screen.getByText('Linked work could not be loaded.')).toBeInTheDocument()
  })

  it('offers "Mark compliant" only as an explicit action once every task is done, and never marks it verified', async () => {
    const work = workFor('B.1', [task('a', { state: 'done' }), task('b', { state: 'done' })])
    const h = renderRow(row({ key: 'B.1', state: 'wip' }), { work })
    // Finishing the tasks changed nothing on its own.
    expect(h.onSetState).not.toHaveBeenCalled()
    expect(screen.getByText(/does not verify it/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /mark compliant/i }))
    expect(h.onSetState).toHaveBeenCalledTimes(1)
    expect(h.onSetState).toHaveBeenCalledWith('B.1', 'compliant')
  })

  it.each(['compliant', 'verified', 'na'] as const)('does not offer "Mark compliant" for a rule already %s', (state) => {
    const work = workFor('B.1', [task('a', { state: 'done' })])
    renderRow(row({ key: 'B.1', state }), { work })
    expect(screen.queryByRole('button', { name: /mark compliant/i })).not.toBeInTheDocument()
  })

  it('does not offer it while any counted task is unfinished, or an archived one never finished', () => {
    renderRow(row({ key: 'B.1' }), { work: workFor('B.1', [task('a', { state: 'done' }), task('b', { state: 'wip' })]) })
    expect(screen.queryByRole('button', { name: /mark compliant/i })).not.toBeInTheDocument()
  })
})

describe('Open in Requirements Book', () => {
  it('goes to the recorded page for the same edition', () => {
    const r = row({ key: 'B.2.1.2' })
    r.clause.source_page = 12
    r.clause.regs_ref = 'ED1'
    renderRow(r)
    expect(screen.getByTestId('book-link-B.2.1.2')).toHaveAttribute('href', '/book?page=12&ref=B.2.1.2')
    expect(screen.queryByTestId('book-note')).not.toBeInTheDocument()
  })

  it('opens the start and says the page is not recorded when it is unknown', () => {
    const r = row({ key: 'B.2.1.2' })
    r.clause.source_page = null
    r.clause.regs_ref = 'ED1'
    renderRow(r)
    expect(screen.getByTestId('book-link-B.2.1.2')).toHaveAttribute('href', '/book?ref=B.2.1.2')
    expect(screen.getByTestId('book-note')).toHaveTextContent('Page not recorded')
  })

  it('ignores a page recorded for a different edition than the season reads', () => {
    const r = row({ key: 'B.2.1.2' })
    r.clause.source_page = 12
    r.clause.regs_ref = 'OLD-EDITION'
    renderRow(r)
    expect(screen.getByTestId('book-link-B.2.1.2')).toHaveAttribute('href', '/book?ref=B.2.1.2')
    expect(screen.getByTestId('book-note')).toHaveTextContent('different edition')
  })

  it('never invents a page when the season has no edition', () => {
    const r = row({ key: 'B.2.1.2' })
    r.clause.source_page = 12
    r.clause.regs_ref = 'ED1'
    renderRow(r, { seasonRegsRef: null })
    expect(screen.getByTestId('book-link-B.2.1.2')).toHaveAttribute('href', '/book?ref=B.2.1.2')
  })
})

describe('label explanations', () => {
  it('opens the explanation on click and keeps it for assistive technology', async () => {
    const r = row({ key: 'B.1' })
    r.clause.criticality = 'blocking'
    renderRow(r)
    const badge = screen.getByRole('button', { name: 'NC RISK' })
    expect(badge).toHaveAccessibleDescription(/scores NC/i)
    expect(badge).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('criticality-B.1-explanation')).not.toBeInTheDocument()
    await userEvent.click(badge)
    expect(badge).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('criticality-B.1-explanation')).toHaveTextContent(/scores NC/i)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('criticality-B.1-explanation')).not.toBeInTheDocument()
  })

  it('shows the explanation on keyboard focus and hover, not only on a tap', async () => {
    const r = row({ key: 'B.1' })
    r.clause.criticality = 'penalty'
    renderRow(r)
    await userEvent.tab()
    // First tab stop is the first explained label on the row.
    expect(screen.getByTestId('criticality-B.1')).toHaveFocus()
    expect(screen.getByTestId('criticality-B.1-explanation')).toHaveTextContent(/penalty points/i)
    await userEvent.tab()
    expect(screen.queryByTestId('criticality-B.1-explanation')).not.toBeInTheDocument()
    await userEvent.hover(screen.getByTestId('criticality-B.1'))
    expect(screen.getByTestId('criticality-B.1-explanation')).toBeInTheDocument()
  })

  it('explains SPORTING (a kind of rule) separately from PENALTY (a consequence)', () => {
    const r = row({ key: 'B.1' })
    r.clause.obligation = 'sporting'
    r.clause.criticality = 'penalty'
    renderRow(r)
    expect(screen.getByRole('button', { name: 'SPORTING' })).toHaveAccessibleDescription(/competition is run/i)
    expect(screen.getByRole('button', { name: 'PENALTY' })).toHaveAccessibleDescription(/penalty points/i)
  })

  it('says PARKED is about competition scope, not an archived department', () => {
    renderRow(row({ key: 'G.1', isParked: true }))
    const parked = screen.getByRole('button', { name: 'PARKED' })
    expect(parked).toHaveAccessibleDescription(/Final Event/)
    expect(parked).toHaveAccessibleDescription(/not the same as a department being archived/)
  })
})
