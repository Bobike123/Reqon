import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A stateful fake Postgres. Writes persist, so this exercises the real hooks,
// the real mutations and the real cache invalidation — not mocked-out results.

const SEASON = { id: 'season-a', label: '2026/27', is_current: true }
const MEMBER = { id: 'm1', full_name: 'Ada Rider', is_board: true, status: 'active' }
const MEMBER2 = { id: 'm2', full_name: 'Bo Wrench', is_board: false, status: 'active' }

let db: Record<string, Record<string, unknown>[]>
let insertCount: Record<string, number>

function reset() {
  db = {
    v_current_season: [SEASON],
    seasons: [SEASON],
    members: [MEMBER, MEMBER2],
    topics: [],
    tasks: [],
    clauses: [],
    clause_status: [],
    subteams: [],
    milestones: [{ key: 'MS1-1', season_id: 'season-a', ordinal: 1, name: 'Team Plan', due_on: '2099-11-30', max_points: 75 }],
    v_subteam_progress: [],
    v_attention: [],
  }
  insertCount = {}
}

let nextId = 1
function makeBuilder(table: string) {
  const ctx: { op: string; payload?: Record<string, unknown>; filters: Record<string, unknown>; single: boolean } = {
    op: 'select', filters: {}, single: false,
  }
  const run = () => {
    let rows = [...(db[table] ?? [])]
    if (ctx.op === 'insert') {
      insertCount[table] = (insertCount[table] ?? 0) + 1
      // Column defaults come from the schema, so the fake supplies them too —
      // the app deliberately does not send `state` when raising a topic.
      const defaults: Record<string, Record<string, unknown>> = {
        topics: { state: 'open', starred: false, decision: null, owner_id: null, decided_at: null, meeting_id: null, raised_on: '2026-09-09' },
        tasks: { state: 'todo', starred: false, owner_id: null, due_date: null, detail: null, source_topic: null, subteam_key: null },
      }
      const row: Record<string, unknown> = {
        id: `${table}-${nextId++}`,
        ...(defaults[table] ?? {}),
        ...ctx.payload,
      }
      // The stamp_decided trigger lives in the database, not in React.
      if (table === 'topics' && row.state === 'decided') row.decided_at = new Date().toISOString()
      db[table].push(row)
      return { data: ctx.single ? row : [row], error: null }
    }
    if (ctx.op === 'update') {
      const updated: Record<string, unknown>[] = []
      db[table] = db[table].map((r) => {
        const match = Object.entries(ctx.filters).every(([k, v]) => r[k] === v)
        if (!match) return r
        const next = { ...r, ...ctx.payload }
        if (table === 'topics' && next.state === 'decided' && r.state !== 'decided') {
          next.decided_at = new Date().toISOString()
        }
        updated.push(next)
        return next
      })
      return { data: ctx.single ? (updated[0] ?? null) : updated, error: null }
    }
    for (const [k, v] of Object.entries(ctx.filters)) rows = rows.filter((r) => r[k] === v)
    return { data: ctx.single ? (rows[0] ?? null) : rows, error: null }
  }

  const b: Record<string, unknown> = {
    select: () => b, order: () => b, in: () => b, range: () => b, limit: () => b,
    eq: (c: string, v: unknown) => { ctx.filters[c] = v; return b },
    insert: (p: Record<string, unknown>) => { ctx.op = 'insert'; ctx.payload = p; return b },
    update: (p: Record<string, unknown>) => { ctx.op = 'update'; ctx.payload = p; return b },
    upsert: (p: Record<string, unknown>) => { ctx.op = 'insert'; ctx.payload = p; return b },
    single: () => { ctx.single = true; return b },
    maybeSingle: () => { ctx.single = true; return b },
    then: (resolve: (v: unknown) => void) => { resolve(run()); return Promise.resolve() },
  }
  return b
}

const supabase = {
  from: (t: string) => makeBuilder(t),
  channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
  removeChannel: () => {},
}
vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'm1' }, member: MEMBER }),
}))
vi.mock('../data/useRealtimeClauseStatus.ts', () => ({ useRealtimeClauseStatus: () => 'live' }))

const { default: Now } = await import('./Now.tsx')
const { default: Board } = await import('./Board.tsx')
const { default: Meetings } = await import('./Meetings.tsx')
const { TutorialProvider } = await import('../tutorial/TutorialProvider.tsx')
const { AppHeader } = await import('../ui/AppHeader.tsx')

function renderApp(initial = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        {/* The real app shell: navigation lives in the header now. */}
        <TutorialProvider>
        <AppHeader />
        <Routes>
          <Route path="/" element={<Now />} />
          <Route path="/board" element={<Board />} />
          {/* The ACCEPTANCE test never navigates here — it is registered only
              so the other tests can exercise the archive states (parked), which
              the Now screen deliberately hides. */}
          <Route path="/meetings" element={<Meetings />} />
        </Routes>
        </TutorialProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => { reset(); vi.clearAllMocks() })

describe('ACCEPTANCE: Now -> agenda -> decision -> decided -> task -> Board', () => {
  it('completes the whole workflow without ever visiting Meetings', async () => {
    const user = userEvent.setup()
    renderApp('/')

    // --- 1. Raise a topic, from the Now screen -----------------------------
    await screen.findByText('Topics needing attention')
    await user.type(screen.getByLabelText('Raise a topic'), 'Fairing width tolerance')
    await user.type(screen.getByLabelText('Context (optional)'), 'B.2.1.2 is blocked')
    await user.click(screen.getByRole('button', { name: 'Raise topic' }))

    await waitFor(() => expect(db.topics).toHaveLength(1))
    const topicId = db.topics[0].id as string
    expect(db.topics[0]).toMatchObject({
      title: 'Fairing width tolerance',
      state: 'open',
      season_id: 'season-a',
      raised_by: 'm1',
    })
    // Re-query the card each time: React replaces these nodes on re-render,
    // and a cached reference silently detaches from the document.
    const card = () => screen.getByTestId(`topic-${topicId}`)
    await screen.findByTestId(`topic-${topicId}`)

    // --- 2. Move it to the agenda -----------------------------------------
    await user.selectOptions(within(card()).getByLabelText(/^State for/), 'agenda')
    await waitFor(() => expect(db.topics[0].state).toBe('agenda'))

    // --- 3. Record a decision (while it is still on the agenda) -----------
    const decision = within(card()).getByLabelText('Decision')
    await user.type(decision, 'Keep 450 mm; ask the Organization to confirm.')
    await user.tab()
    await waitFor(() =>
      expect(db.topics[0].decision).toBe('Keep 450 mm; ask the Organization to confirm.'),
    )

    // --- 4. Mark it decided ------------------------------------------------
    await user.selectOptions(within(card()).getByLabelText(/^State for/), 'decided')
    await waitFor(() => expect(db.topics[0].state).toBe('decided'))
    // The decision survived the state change and is still editable.
    expect(db.topics[0].decision).toBe('Keep 450 mm; ask the Organization to confirm.')
    expect(within(card()).getByLabelText('Decision')).toBeEnabled()

    // --- 5. Convert it to a task ------------------------------------------
    await user.click(within(card()).getByTestId(`convert-${topicId}`))
    await waitFor(() => expect(db.tasks).toHaveLength(1))
    expect(db.tasks[0]).toMatchObject({
      title: 'Fairing width tolerance',
      state: 'todo',
      source_topic: topicId,
      created_by: 'm1',
      season_id: 'season-a',
    })

    // --- 6. Open the Board -------------------------------------------------
    await user.click(screen.getByRole('link', { name: 'Board' }))
    await screen.findByRole('heading', { name: 'Board', level: 1 })

    // --- 7. The task is there, in To do, and names its origin --------------
    const taskId = db.tasks[0].id as string
    const taskCard = await screen.findByTestId(`task-${taskId}`)
    expect(taskCard).toHaveAttribute('data-source-topic', topicId)
    expect(taskCard).toHaveAttribute('data-task-state', 'todo')
    expect(within(screen.getByTestId('lane-todo')).getByTestId(`task-${taskId}`)).toBeInTheDocument()
    expect(screen.getByTestId(`task-origin-${taskId}`)).toHaveTextContent('Fairing width tolerance')

    // And Meetings was never rendered.
    expect(screen.queryByRole('heading', { name: 'Meetings' })).not.toBeInTheDocument()
  })
})

describe('the decision field is never a dead end', () => {
  it('stays editable in every topic state', async () => {
    const user = userEvent.setup()
    db.topics = [
      { id: 't1', season_id: 'season-a', title: 'T', context: null, state: 'open', decision: null, owner_id: null, starred: false, raised_by: 'm1', raised_on: '2026-01-01', decided_at: null, meeting_id: null, updated_at: '2026-01-01' },
    ]
    renderApp('/meetings')
    await screen.findByTestId('topic-t1')
    const card = () => screen.getByTestId('topic-t1')

    for (const state of ['agenda', 'decided', 'parked', 'open']) {
      await user.selectOptions(within(card()).getByLabelText(/^State for/), state)
      await waitFor(() => expect(db.topics[0].state).toBe(state))
      expect(
        within(card()).getByLabelText('Decision'),
        `decision must stay editable while ${state}`,
      ).toBeEnabled()
    }
  })
})

describe('duplicate protection', () => {
  it('does not create a second task when convert is clicked twice', async () => {
    const user = userEvent.setup()
    db.topics = [
      { id: 't1', season_id: 'season-a', title: 'Order tyres', context: null, state: 'decided', decision: 'do it', owner_id: null, starred: false, raised_by: 'm1', raised_on: '2026-01-01', decided_at: null, meeting_id: null, updated_at: '2026-01-01' },
    ]
    renderApp('/meetings')
    await screen.findByTestId('topic-t1')
    await user.click(within(screen.getByTestId('topic-t1')).getByTestId('convert-t1'))
    await waitFor(() => expect(db.tasks).toHaveLength(1))

    // The button is replaced by a "converted" badge, and the mutation is
    // idempotent even if something calls it again.
    await waitFor(() => expect(screen.getByTestId('topic-converted-t1')).toBeInTheDocument())
    expect(db.tasks).toHaveLength(1)
    expect(insertCount.tasks).toBe(1)
  })

  it('the conversion mutation itself is idempotent, not just the button', async () => {
    // The UI swaps the button for a badge after converting, so a second click
    // is impossible on screen. That is not enough: a retry, a stale tab or a
    // reload-and-click-again would still reach the mutation. Call it twice
    // directly and prove only one task is ever inserted.
    const topic = {
      id: 't9', season_id: 'season-a', title: 'Order tyres', context: null,
      state: 'decided', decision: 'do it', owner_id: null, starred: false,
      raised_by: 'm1', raised_on: '2026-01-01', decided_at: null,
      meeting_id: null, updated_at: '2026-01-01',
    }
    db.topics = [topic]

    const { useConvertTopicToTask } = await import('../data/useTopics.ts')
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { useCurrentSeason } = await import('../data/useCurrentSeason.ts')
    const season = renderHook(() => useCurrentSeason(), { wrapper })
    await waitFor(() => expect(season.result.current.data).toBeTruthy())

    const { result } = renderHook(() => useConvertTopicToTask(), { wrapper })
    // The mutation refuses to guess a season, so wait until one is resolved.
    await waitFor(() => expect(result.current).toBeTruthy())

    const first = await result.current.mutateAsync(topic as never)
    const second = await result.current.mutateAsync(topic as never)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.task.id).toBe(first.task.id)
    expect(db.tasks).toHaveLength(1)
    expect(insertCount.tasks).toBe(1)
  })

  it('does not raise two topics from a double submit', async () => {
    const user = userEvent.setup()
    renderApp('/')
    await screen.findByText('Topics needing attention')
    await user.type(screen.getByLabelText('Raise a topic'), 'Only once')
    const btn = screen.getByRole('button', { name: 'Raise topic' })
    await user.tripleClick(btn)
    await waitFor(() => expect(db.topics.length).toBeGreaterThan(0))
    expect(db.topics).toHaveLength(1)
  })
})

describe('task board', () => {
  beforeEach(() => {
    db.tasks = [
      { id: 'k1', season_id: 'season-a', title: 'Order fairing material', detail: null, state: 'todo', owner_id: null, due_date: null, starred: false, source_topic: null, created_by: 'm1', subteam_key: null, created_at: '', updated_at: '' },
    ]
  })

  it('renders all six lanes', async () => {
    renderApp('/board')
    for (const lane of ['urgent', 'todo', 'wip', 'blocked', 'done', 'cancelled']) {
      expect(await screen.findByTestId(`lane-${lane}`)).toBeInTheDocument()
    }
  })

  it('moves a task between lanes and persists the new state', async () => {
    const user = userEvent.setup()
    renderApp('/board')
    const card = await screen.findByTestId('task-k1')
    await user.selectOptions(within(card).getByLabelText(/^Move /), 'wip')
    await waitFor(() => expect(db.tasks[0].state).toBe('wip'))
    await waitFor(() =>
      expect(within(screen.getByTestId('lane-wip')).getByTestId('task-k1')).toBeInTheDocument(),
    )
  })

  it('assigns an owner from the member list', async () => {
    const user = userEvent.setup()
    renderApp('/board')
    const card = await screen.findByTestId('task-k1')
    const owner = within(card).getByLabelText(/^Owner for/)
    expect([...(owner as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Unassigned', 'Ada Rider', 'Bo Wrench',
    ])
    await user.selectOptions(owner, 'm2')
    await waitFor(() => expect(db.tasks[0].owner_id).toBe('m2'))
  })

  it('is keyboard operable — the movement control is a real select', async () => {
    renderApp('/board')
    const card = await screen.findByTestId('task-k1')
    const move = within(card).getByLabelText(/^Move /)
    expect(move.tagName).toBe('SELECT')
    move.focus()
    expect(document.activeElement).toBe(move)
  })
})

