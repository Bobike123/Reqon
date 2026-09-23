import { ChangePasswordForm } from '../../account/ChangePasswordForm.tsx'

// Your own account. ChangePasswordForm already owns its own form state,
// pending state and action errors — this just gives that section its name.
export function AccountSettings() {
  return <ChangePasswordForm />
}
