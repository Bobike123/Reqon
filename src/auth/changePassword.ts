import type { AuthError } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase.ts'

// Which field a problem belongs to, so the form can put the message next to it.
export type PasswordField = 'current' | 'next'

export class PasswordChangeError extends Error {
  field: PasswordField | null
  constructor(message: string, field: PasswordField | null) {
    super(message)
    this.name = 'PasswordChangeError'
    this.field = field
  }
}

// Changing your own password, in three steps against Supabase Auth.
export async function changePassword({
  email,
  currentPassword,
  newPassword,
}: {
  email: string
  currentPassword: string
  newPassword: string
}): Promise<{ otherDevicesSignedOut: boolean }> {
  // 1. Prove it is really them: the current password has to sign in. Supabase's
  //    updateUser() does not ask for it on its own, so without this anyone who
  //    found the app open on someone's laptop could lock the owner out.
  const check = await supabase.auth.signInWithPassword({ email, password: currentPassword })
  if (check.error) {
    // Recognised by code where Supabase sends one, by its message where not.
    const wrongPassword =
      check.error.code === 'invalid_credentials' || /invalid login credentials/i.test(check.error.message)
    if (wrongPassword) {
      throw new PasswordChangeError('That isn’t your current password.', 'current')
    }
    throw new PasswordChangeError(describe(check.error), null)
  }

  // 2. Change it. current_password goes along too, for projects where Supabase
  //    is set to check it itself ("secure password change").
  const { error } = await supabase.auth.updateUser({ password: newPassword, current_password: currentPassword })
  if (error) throw new PasswordChangeError(describe(error), fieldFor(error))

  // 3. Sign out every other device: a new password should shut out anyone who
  //    knew the old one. Best effort — the change itself has already happened.
  const { error: signOutError } = await supabase.auth.signOut({ scope: 'others' })
  return { otherDevicesSignedOut: !signOutError }
}

function fieldFor(error: AuthError): PasswordField | null {
  return error.code === 'same_password' || error.code === 'weak_password' ? 'next' : null
}

function describe(error: AuthError): string {
  switch (error.code) {
    case 'same_password':
      return 'Your new password must be different from your current one.'
    case 'weak_password':
      return `That password is too weak: ${error.message}`
    case 'over_request_rate_limit':
      return 'Too many attempts. Wait a minute, then try again.'
    case 'reauthentication_needed':
    case 'reauthentication_not_valid':
      return 'Supabase wants you to sign in again first: sign out, sign back in, then change your password.'
    default:
      return `Could not change your password: ${error.message}`
  }
}
