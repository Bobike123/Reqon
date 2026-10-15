import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClubCredential } from '../data/useClubCredentials.ts'
import { ClubAccountsPanel } from './ClubAccounts.tsx'

const SECRET = 'Fixture-Pw-7f3a!Zq'

const h = vi.hoisted(() => ({
  tables: [] as string[],
  rows: [] as unknown[],
  listError: null as unknown,
  members: [] as unknown[],
  rpc: vi.fn(),
  copy: vi.fn(),
  copied: null as string | null,
}))

vi.mock('../lib/supabase.ts', () => ({
  supabase: {
    from: (table: string) => {
      h.tables.push(table)
      let from = 0
      const q = {
        select: () => q,
        order: () => q,
        range: (start: number) => {
          from = start
          return q
        },
        then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => {
          const result =
            table === 'members'
              ? { data: from === 0 ? h.members : [], error: null }
              : h.listError
                ? { data: null, error: h.listError }
                : { data: h.rows, error: null }
          return Promise.resolve(result).then(ok, bad)
        },
      }
      return q
    },
    rpc: (...args: unknown[]) => h.rpc(...args),
  },
}))

// What reaches the clipboard is checked here without a real clipboard; the helper has its own tests.
vi.mock('./clipboard.ts', () => ({ copyToClipboard: (text: unknown) => h.copy(text) }))

const row = (over: Partial<ClubCredential>): ClubCredential => ({
  id: 'c1', service: 'Cloudflare', login: 'club@example.test', has_secret: true, sort_order: 10,
  updated_at: null, updated_by: null, last_revealed_at: null, last_revealed_by: null, ...over,
})

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ClubAccountsPanel />
    </QueryClientProvider>,
  )
}

async function open() {
  const user = userEvent.setup()
  renderPanel()
  await user.click(screen.getByTestId('club-accounts-open'))
  await screen.findByTestId('account-cloudflare')
  return user
}

beforeEach(() => {
  h.tables = []
  h.listError = null
  h.members = []
  h.copied = null
  h.rows = [
    row({}),
    row({ id: 'c2', service: 'Supabase', login: 'owner@example.test', sort_order: 20 }),
    row({ id: 'c3', service: 'Vercel', login: '', has_secret: false, sort_order: 30 }),
  ]
  h.rpc.mockReset()
  h.rpc.mockImplementation(async (name: string) => {
    if (name === 'reveal_club_credential') return { data: SECRET, error: null }
    if (name === 'add_club_credential') return { data: 'new-id', error: null }
    return { data: null, error: null }
  })
  h.copy.mockReset()
  h.copy.mockImplementation(async (text: unknown) => {
    h.copied = await (text as string | Promise<string>)
  })
})

describe('Settings → Club accounts', () => {
  it('reads nothing from the database until the overlay is opened', async () => {
    renderPanel()
    expect(screen.getByTestId('club-accounts-open')).toBeInTheDocument()
    expect(screen.queryByTestId('club-accounts-dialog')).not.toBeInTheDocument()
    expect(h.tables).not.toContain('club_credentials')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('lists the accounts with the password hidden behind a fixed mask', async () => {
    await open()
    expect(screen.getByTestId('account-supabase')).toBeInTheDocument()
    const cloudflare = screen.getByTestId('account-cloudflare')
    expect(within(cloudflare).getByTestId('login-cloudflare')).toHaveTextContent('club@example.test')
    expect(within(cloudflare).getByTestId('password-mask')).toHaveTextContent('••••••••••••')
    expect(within(cloudflare).getByTestId('password-mask')).toHaveAccessibleName('Password hidden')
    // Same mask for every account: the length of a password is not hinted at either.
    expect(within(screen.getByTestId('account-supabase')).getByTestId('password-mask')).toHaveTextContent('••••••••••••')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('has no way to show the password: no reveal control, no input holding it', async () => {
    await open()
    expect(screen.queryByRole('button', { name: /show|reveal|view/i })).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument()
  })

  it('copies the password to the clipboard and never puts it on the page', async () => {
    const user = await open()
    const cloudflare = screen.getByTestId('account-cloudflare')
    await user.click(within(cloudflare).getByTestId('copy-password'))

    expect(await within(cloudflare).findByTestId('copied-note')).toHaveTextContent('Password copied')
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('reveal_club_credential', { p_id: 'c1' })
    expect(h.copied).toBe(SECRET)
    expect(document.body).not.toHaveTextContent(SECRET)
    expect(document.body.innerHTML).not.toContain(SECRET)
  })

  it('copies the login too, without asking the database', async () => {
    const user = await open()
    await user.click(within(screen.getByTestId('account-supabase')).getByRole('button', { name: 'Copy login' }))
    await waitFor(() => expect(h.copied).toBe('owner@example.test'))
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('says so, and copies nothing, when the database refuses', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Only the President and Developers can open the club accounts.' } })
    const user = await open()
    await user.click(within(screen.getByTestId('account-cloudflare')).getByTestId('copy-password'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the President and Developers can open the club accounts.')
    expect(h.copied).toBeNull()
    expect(screen.queryByTestId('copied-note')).not.toBeInTheDocument()
  })

  it('offers no copy for an account that has no password yet', async () => {
    await open()
    const vercel = screen.getByTestId('account-vercel')
    expect(within(vercel).getByText('No password saved yet')).toBeInTheDocument()
    expect(within(vercel).getByTestId('copy-password')).toBeDisabled()
    expect(within(vercel).getByText('Not filled in yet')).toBeInTheDocument()
    expect(within(vercel).queryByRole('button', { name: 'Copy login' })).not.toBeInTheDocument()
    expect(within(vercel).getByRole('button', { name: 'Add login and password' })).toBeInTheDocument()
  })

  it('shows who copied a password last and when', async () => {
    h.rows = [row({ last_revealed_at: '2026-10-14T09:30:00Z', last_revealed_by: 'm1' })]
    h.members = [{ id: 'm1', full_name: 'Test President', status: 'active', role: 'Member' }]
    await open()
    await waitFor(() => expect(screen.getByTestId('last-copied')).toHaveTextContent('Last copied by Test President on'))
  })

  it('names nobody it cannot find', async () => {
    h.rows = [row({ last_revealed_at: '2026-10-14T09:30:00Z', last_revealed_by: 'gone' })]
    await open()
    expect(await screen.findByTestId('last-copied')).toHaveTextContent('Last copied by someone on')
  })

  it('saves a new login and password, then confirms', async () => {
    const user = await open()
    const vercel = screen.getByTestId('account-vercel')
    await user.click(within(vercel).getByRole('button', { name: 'Add login and password' }))
    const form = within(vercel).getByTestId('edit-vercel')
    const save = within(form).getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()

    await user.type(within(form).getByLabelText(/Login/), '  vercel@example.test ')
    await user.type(within(form).getByLabelText('Password'), 'Fixture-New-1')
    expect(within(form).getByLabelText('Password')).toHaveAttribute('type', 'password')
    await user.click(save)

    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith('save_club_credential', { p_id: 'c3', p_login: 'vercel@example.test', p_secret: 'Fixture-New-1' }),
    )
    expect(await within(vercel).findByText('Saved.')).toBeInTheDocument()
    expect(screen.queryByTestId('edit-vercel')).not.toBeInTheDocument()
  })

  it('keeps the password when only the login is edited (no secret is sent)', async () => {
    const user = await open()
    const cloudflare = screen.getByTestId('account-cloudflare')
    await user.click(within(cloudflare).getByRole('button', { name: 'Change login or password' }))
    const form = within(cloudflare).getByTestId('edit-cloudflare')
    expect(within(form).getByLabelText('New password')).toHaveAttribute('placeholder', 'Leave empty to keep the saved one')
    const login = within(form).getByLabelText(/Login/)
    await user.clear(login)
    await user.type(login, 'other@example.test')
    await user.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('save_club_credential', { p_id: 'c1', p_login: 'other@example.test' }))
  })

  it('shows a refused save and keeps the form open', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Only the President and Developers can change the club accounts.' } })
    const user = await open()
    const cloudflare = screen.getByTestId('account-cloudflare')
    await user.click(within(cloudflare).getByRole('button', { name: 'Change login or password' }))
    await user.type(within(cloudflare).getByLabelText('New password'), 'Fixture-New-2')
    await user.click(within(cloudflare).getByRole('button', { name: 'Save' }))
    expect(await within(cloudflare).findByRole('alert')).toHaveTextContent('Only the President and Developers can change the club accounts.')
    expect(within(cloudflare).getByTestId('edit-cloudflare')).toBeInTheDocument()
  })

  it('cancels an edit without saving', async () => {
    const user = await open()
    const cloudflare = screen.getByTestId('account-cloudflare')
    await user.click(within(cloudflare).getByRole('button', { name: 'Change login or password' }))
    await user.type(within(cloudflare).getByLabelText('New password'), 'never-sent')
    await user.click(within(cloudflare).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('edit-cloudflare')).not.toBeInTheDocument()
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('adds an account with a login and password, then confirms', async () => {
    const user = await open()
    await user.click(screen.getByTestId('add-account-open'))
    const form = screen.getByTestId('add-account-form')
    const submit = within(form).getByRole('button', { name: 'Add account' })
    expect(submit).toBeDisabled()

    await user.type(within(form).getByLabelText('Account name'), '  GitHub ')
    expect(submit).toBeEnabled()
    await user.type(within(form).getByLabelText(/Login/), ' gh@example.test ')
    await user.type(within(form).getByLabelText(/Password/), 'Fixture-Gh-1')
    expect(within(form).getByLabelText(/Password/)).toHaveAttribute('type', 'password')
    await user.click(submit)

    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith('add_club_credential', { p_service: 'GitHub', p_login: 'gh@example.test', p_secret: 'Fixture-Gh-1' }),
    )
    expect(await screen.findByTestId('added-note')).toHaveTextContent('Added GitHub.')
    expect(screen.queryByTestId('add-account-form')).not.toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain('Fixture-Gh-1')
  })

  it('adds an account without a password (none is sent)', async () => {
    const user = await open()
    await user.click(screen.getByTestId('add-account-open'))
    const form = screen.getByTestId('add-account-form')
    await user.type(within(form).getByLabelText('Account name'), 'Google Drive')
    await user.click(within(form).getByRole('button', { name: 'Add account' }))
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('add_club_credential', { p_service: 'Google Drive', p_login: '' }))
  })

  it('shows the database’s reason when the name already exists, and keeps what was typed', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'There is already an account called Vercel.' } })
    const user = await open()
    await user.click(screen.getByTestId('add-account-open'))
    const form = screen.getByTestId('add-account-form')
    await user.type(within(form).getByLabelText('Account name'), 'Vercel')
    await user.click(within(form).getByRole('button', { name: 'Add account' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('There is already an account called Vercel.')
    expect(within(form).getByLabelText('Account name')).toHaveValue('Vercel')
    expect(screen.queryByTestId('added-note')).not.toBeInTheDocument()
  })

  it('cancels adding without calling the database and starts blank next time', async () => {
    const user = await open()
    await user.click(screen.getByTestId('add-account-open'))
    await user.type(within(screen.getByTestId('add-account-form')).getByLabelText('Account name'), 'Never saved')
    await user.click(within(screen.getByTestId('add-account-form')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('add-account-form')).not.toBeInTheDocument()
    expect(h.rpc).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('add-account-open'))
    expect(within(screen.getByTestId('add-account-form')).getByLabelText('Account name')).toHaveValue('')
  })

  it('reports a list that could not be loaded', async () => {
    h.listError = { code: 'XX000', message: 'boom' }
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByTestId('club-accounts-open'))
    expect(await screen.findByText(/Could not load the club accounts/)).toBeInTheDocument()
  })

  it('closes with the Close button and starts clean next time', async () => {
    const user = await open()
    await user.click(within(screen.getByTestId('account-cloudflare')).getByTestId('copy-password'))
    await screen.findByTestId('copied-note')
    await user.click(screen.getByTestId('club-accounts-close'))
    expect(screen.queryByTestId('club-accounts-dialog')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('club-accounts-open'))
    await screen.findByTestId('account-cloudflare')
    expect(screen.queryByTestId('copied-note')).not.toBeInTheDocument()
  })
})
