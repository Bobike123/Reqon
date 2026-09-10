import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Fake Supabase ---------------------------------------------------------
// One shared fake stands in for the real client. Each test sets what the
// session is and what the `members` lookup returns, which is exactly the two
// facts the auth state depends on.

type AuthCallback = (event: string, session: unknown) => void

const state = {
  session: null as unknown,
  memberRow: null as unknown,
  memberError: null as { message: string } | null,
  callbacks: [] as AuthCallback[],
  signInResult: { error: null as { message: string } | null },
  signOutCalls: 0,
  signOutThrows: false,
  memberQueries: 0,
}

const supabase = {
  auth: {
    getSession: vi.fn(async () => ({ data: { session: state.session } })),
    onAuthStateChange: vi.fn((cb: AuthCallback) => {
      state.callbacks.push(cb)
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    }),
    signInWithPassword: vi.fn(async () => state.signInResult),
    signOut: vi.fn(async () => {
      state.signOutCalls += 1
      if (state.signOutThrows) throw new Error('offline')
      state.session = null
      state.callbacks.forEach((cb) => cb('SIGNED_OUT', null))
      return { error: null }
    }),
  },
  from: vi.fn(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => {
          state.memberQueries += 1
          return { data: state.memberRow, error: state.memberError }
        },
      }),
    }),
  })),
}

vi.mock('../lib/supabase.ts', () => ({ get supabase() { return supabase } }))

const { AuthProvider } = await import('./AuthProvider.tsx')
const { useAuth } = await import('./context.ts')
const { default: RequireAuth } = await import('./RequireAuth.tsx')

const ROSTERED_SESSION = { user: { id: 'user-1', email: 'rostered@sdu.dk' } }
const MEMBER_ROW = { id: 'user-1', full_name: 'Ada Rider', is_board: false, status: 'active' }

let queryClient: QueryClient

function Protected() {
  const { signOut } = useAuth()
  return (
    <>
      <p>SECRET BIKE DATA</p>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </>
  )
}

function renderApp(children: ReactNode = <Protected />) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RequireAuth>{children}</RequireAuth>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  state.session = null
  state.memberRow = null
  state.memberError = null
  state.callbacks = []
  state.signInResult = { error: null }
  state.signOutCalls = 0
  state.signOutThrows = false
  state.memberQueries = 0
  vi.clearAllMocks()
})

// --- Tests -----------------------------------------------------------------

describe('signed out', () => {
  it('shows the login form and never the protected UI', async () => {
    renderApp()
    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.queryByText('SECRET BIKE DATA')).not.toBeInTheDocument()
  })

  it('offers no public sign-up and no dead password-reset link', async () => {
    renderApp()
    await screen.findByLabelText('Email')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.queryByText(/sign up/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/forgot|reset/i)).not.toBeInTheDocument()
  })

  it('shows the auth error when the credentials are wrong', async () => {
    state.signInResult = { error: { message: 'Invalid login credentials' } }
    renderApp()
    await userEvent.type(await screen.findByLabelText('Email'), 'nobody@sdu.dk')
    await userEvent.type(screen.getByLabelText('Password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid login credentials')
    expect(screen.queryByText('SECRET BIKE DATA')).not.toBeInTheDocument()
  })
})

describe('signed in and on the roster', () => {
  it('renders the protected UI', async () => {
    state.session = ROSTERED_SESSION
    state.memberRow = MEMBER_ROW
    renderApp()
    expect(await screen.findByText('SECRET BIKE DATA')).toBeInTheDocument()
  })
})

describe('signed in but NOT on the roster', () => {
  beforeEach(() => {
    state.session = { user: { id: 'stranger-1', email: 'stranger@sdu.dk' } }
    state.memberRow = null
  })

  it('shows the exact roster message and blocks the app', async () => {
    renderApp()
    expect(
      await screen.findByText(
        'Your account is not on the club roster; ask the board to add you.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('SECRET BIKE DATA')).not.toBeInTheDocument()
  })

  it('is not treated as signed out — it offers sign-out, not a login form', async () => {
    renderApp()
    await screen.findByText(/not on the club roster/)
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })
})

describe('while authorization is still resolving', () => {
  it('shows a loading state, not the protected UI', async () => {
    state.session = ROSTERED_SESSION
    state.memberRow = MEMBER_ROW
    renderApp()
    // Before the member lookup resolves, nothing protected may be on screen.
    expect(screen.queryByText('SECRET BIKE DATA')).not.toBeInTheDocument()
    expect(await screen.findByText('SECRET BIKE DATA')).toBeInTheDocument()
  })
})

describe('when the roster lookup fails', () => {
  it('shows an error, not a silent allow and not a silent deny', async () => {
    state.session = ROSTERED_SESSION
    state.memberError = { message: 'network down' }
    renderApp()
    expect(await screen.findByText('Could not check your account')).toBeInTheDocument()
    expect(screen.queryByText('SECRET BIKE DATA')).not.toBeInTheDocument()
    // Crucially it must NOT claim the user is off the roster.
    expect(screen.queryByText(/not on the club roster/)).not.toBeInTheDocument()
  })
})

describe('sign out', () => {
  it('returns to the login form and clears the query cache', async () => {
    state.session = ROSTERED_SESSION
    state.memberRow = MEMBER_ROW
    renderApp()
    await screen.findByText('SECRET BIKE DATA')

    // Seed the cache with the previous user's data.
    queryClient.setQueryData(['tasks'], [{ id: 1, title: 'previous user task' }])
    expect(queryClient.getQueryData(['tasks'])).toBeDefined()

    const { supabase: client } = await import('../lib/supabase.ts')
    await client.auth.signOut()

    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument())
    expect(screen.queryByText('SECRET BIKE DATA')).not.toBeInTheDocument()
    // The previous user's rows must not survive into the next session.
    expect(queryClient.getQueryData(['tasks'])).toBeUndefined()
  })
})

describe('sign out when the network is down', () => {
  it('still drops the session and the cached rows', async () => {
    state.session = ROSTERED_SESSION
    state.memberRow = MEMBER_ROW
    state.signOutThrows = true
    const { container } = renderApp()
    await screen.findByText('SECRET BIKE DATA')

    queryClient.setQueryData(['tasks'], [{ id: 1, title: 'previous user task' }])

    // The UI calls signOut and the server call fails.
    const { AuthProvider: _p } = await import('./AuthProvider.tsx')
    void _p
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(screen.getByLabelText('Email')).toBeInTheDocument())
    expect(screen.queryByText('SECRET BIKE DATA')).not.toBeInTheDocument()
    expect(queryClient.getQueryData(['tasks'])).toBeUndefined()
    expect(container).toBeTruthy()
  })
})
