import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
}))
vi.mock('../lib/supabase.ts', () => ({ supabase: { auth } }))
vi.mock('../auth/context.ts', () => ({
  useAuth: () => ({ status: 'member', user: { id: 'u1', email: 'ada@club.test' }, member: { id: 'u1' }, roles: [] }),
}))

const { ChangePasswordForm } = await import('./ChangePasswordForm.tsx')

const ok = { data: {}, error: null }
const authError = (code: string, message: string) => ({ data: {}, error: { code, message, name: 'AuthApiError', status: 400 } })

beforeEach(() => {
  auth.signInWithPassword.mockReset().mockResolvedValue(ok)
  auth.updateUser.mockReset().mockResolvedValue(ok)
  auth.signOut.mockReset().mockResolvedValue({ error: null })
})

async function fill(current: string, next: string, confirm = next) {
  const user = userEvent.setup()
  render(<ChangePasswordForm />)
  if (current) await user.type(screen.getByLabelText('Current password'), current)
  if (next) await user.type(screen.getByLabelText('New password'), next)
  if (confirm) await user.type(screen.getByLabelText('Confirm new password'), confirm)
  await user.click(screen.getByRole('button', { name: 'Change password' }))
  return user
}

describe('changing your password', () => {
  it('checks the current password first, then changes it and signs out other devices', async () => {
    await fill('old-pass-1', 'new-pass-12')
    expect(await screen.findByText(/Password changed\. You stay signed in here; any other devices/)).toBeInTheDocument()
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'ada@club.test', password: 'old-pass-1' })
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'new-pass-12', current_password: 'old-pass-1' })
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'others' })
    // Nothing sensitive is left sitting in the form.
    expect(screen.getByLabelText('Current password')).toHaveValue('')
    expect(screen.getByLabelText('New password')).toHaveValue('')
  })

  it('refuses a wrong current password, next to that field, and changes nothing', async () => {
    auth.signInWithPassword.mockResolvedValue(authError('invalid_credentials', 'Invalid login credentials'))
    await fill('wrong-pass', 'new-pass-12')
    const current = screen.getByLabelText('Current password')
    await waitFor(() => expect(current).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByText('That isn’t your current password.')).toBeInTheDocument()
    expect(current).toHaveFocus()
    expect(auth.updateUser).not.toHaveBeenCalled()
  })

  it('recognises a wrong current password even when Supabase sends no error code', async () => {
    auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { message: 'Invalid login credentials', name: 'AuthApiError', status: 400 },
    })
    await fill('wrong-pass', 'new-pass-12')
    expect(await screen.findByText('That isn’t your current password.')).toBeInTheDocument()
    expect(screen.getByLabelText('Current password')).toHaveFocus()
    expect(auth.updateUser).not.toHaveBeenCalled()
  })

  it('moves focus to a general error, so it is not lost when the button was disabled', async () => {
    auth.signInWithPassword.mockResolvedValue(authError('over_request_rate_limit', 'Too many requests'))
    await fill('old-pass-1', 'new-pass-12')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Too many attempts. Wait a minute, then try again.')
    expect(alert).toHaveFocus()
  })

  it('puts focus back on the button after a successful change', async () => {
    await fill('old-pass-1', 'new-pass-12')
    await screen.findByText(/Password changed/)
    expect(screen.getByRole('button', { name: 'Change password' })).toHaveFocus()
  })

  it.each([
    ['a missing current password', '', 'new-pass-12', 'new-pass-12', 'Enter your current password.'],
    ['a short new password', 'old-pass-1', 'short', 'short', 'Use at least 8 characters.'],
    ['a new password equal to the current one', 'same-pass-1', 'same-pass-1', 'same-pass-1', 'Choose a password different from your current one.'],
    ['a confirmation that does not match', 'old-pass-1', 'new-pass-12', 'new-pass-13', 'The two new passwords don’t match.'],
  ])('catches %s before asking Supabase', async (_label, current, next, confirm, message) => {
    await fill(current, next, confirm)
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
    expect(auth.updateUser).not.toHaveBeenCalled()
  })

  it('shows why Supabase rejected a weak password, next to the new password', async () => {
    auth.updateUser.mockResolvedValue(authError('weak_password', 'Password is known to be weak and easy to guess.'))
    await fill('old-pass-1', 'password123')
    expect(await screen.findByText(/That password is too weak: Password is known to be weak/)).toBeInTheDocument()
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByText(/Password changed/)).not.toBeInTheDocument()
  })

  it('still reports the change if other devices could not be signed out', async () => {
    auth.signOut.mockResolvedValue({ error: { message: 'network down' } })
    await fill('old-pass-1', 'new-pass-12')
    expect(await screen.findByText('Password changed. You stay signed in here.')).toBeInTheDocument()
  })

  it('can show the passwords while typing', async () => {
    const user = userEvent.setup()
    render(<ChangePasswordForm />)
    expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'password')
    await user.click(screen.getByLabelText('Show passwords'))
    expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'text')
  })
})
