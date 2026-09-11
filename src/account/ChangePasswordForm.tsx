import { useId, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { useAuth } from '../auth/context.ts'
import { changePassword, PasswordChangeError } from '../auth/changePassword.ts'
import { buttonPrimary } from '../ui/buttons.ts'

type Field = 'current' | 'next' | 'confirm'
type Values = Record<Field, string>

const EMPTY: Values = { current: '', next: '', confirm: '' }
// Supabase stores passwords with bcrypt, which only reads the first 72 bytes.
const MIN = 8
const MAX = 72

// 16px on a phone, so iOS does not zoom the page when a field is tapped.
const input =
  'mt-1 block min-h-11 w-full rounded border border-slate-300 bg-white px-2.5 text-base text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 aria-invalid:border-red-600 sm:min-h-9 sm:text-sm'

function validate({ current, next, confirm }: Values): Partial<Record<Field, string>> {
  const found: Partial<Record<Field, string>> = {}
  if (!current) found.current = 'Enter your current password.'
  if (next.length < MIN) found.next = `Use at least ${MIN} characters.`
  else if (new TextEncoder().encode(next).length > MAX) found.next = `Use at most ${MAX} characters.`
  else if (next === current) found.next = 'Choose a password different from your current one.'
  if (!found.next && confirm !== next) found.confirm = 'The two new passwords don’t match.'
  return found
}

// Anyone signed in can change their own password here. It is not tied to a
// role: it is your account, not club administration.
export function ChangePasswordForm() {
  const auth = useAuth()
  const email = auth.status === 'member' ? (auth.user.email ?? '') : ''
  const ids = useId()
  const [values, setValues] = useState<Values>(EMPTY)
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const formErrorRef = useRef<HTMLParagraphElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)

  const idOf = (field: Field) => `${ids}-${field}`
  const showErrors = (found: Partial<Record<Field, string>>) => {
    // Commit the messages before moving focus, so a screen reader announces
    // the field together with what is wrong with it.
    flushSync(() => setErrors(found))
    const first = (['current', 'next', 'confirm'] as const).find((field) => found[field])
    if (first) document.getElementById(idOf(first))?.focus()
    return Boolean(first)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setStatus('')
    setFormError(null)
    if (showErrors(validate(values))) return
    setBusy(true)
    let failure: unknown = null
    try {
      const { otherDevicesSignedOut } = await changePassword({
        email,
        currentPassword: values.current,
        newPassword: values.next,
      })
      setValues(EMPTY)
      setShow(false)
      setStatus(
        otherDevicesSignedOut
          ? 'Password changed. You stay signed in here; any other devices have been signed out.'
          : 'Password changed. You stay signed in here.',
      )
    } catch (err) {
      failure = err
    }
    // Re-enable the fields before pointing at one: a control inside a
    // disabled fieldset cannot take focus.
    flushSync(() => setBusy(false))
    if (failure instanceof PasswordChangeError && failure.field) {
      showErrors({ [failure.field]: failure.message })
    } else if (failure) {
      flushSync(() => setFormError(failure instanceof Error ? failure.message : 'Could not change your password.'))
      formErrorRef.current?.focus()
    } else {
      // The button was disabled while saving, which drops keyboard focus.
      submitRef.current?.focus()
    }
  }

  const field = (name: Field, label: string, autoComplete: string) => (
    <div>
      <label htmlFor={idOf(name)} className="block text-sm font-medium text-slate-900">
        {label}
      </label>
      <input
        id={idOf(name)}
        name={name === 'current' ? 'current-password' : name === 'next' ? 'new-password' : 'confirm-password'}
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        value={values[name]}
        onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={errors[name] ? `${idOf(name)}-error` : name === 'next' ? `${ids}-rule` : undefined}
        className={input}
      />
      {errors[name] && (
        <p id={`${idOf(name)}-error`} className="mt-1 text-sm text-red-700">
          {errors[name]}
        </p>
      )}
    </div>
  )

  return (
    <form onSubmit={submit} noValidate className="rounded-lg border border-slate-200 bg-white p-3">
      <h3 className="text-sm font-medium text-slate-900">Change your password</h3>
      <p className="mt-0.5 text-xs text-slate-600">
        Signed in as <span className="font-medium text-slate-900">{email}</span>.
      </p>
      {/* Lets a password manager know which account the new password belongs to. */}
      <input hidden readOnly name="username" autoComplete="username" value={email} />

      <fieldset className="mt-3 grid gap-3 sm:max-w-sm" disabled={busy}>
        {field('current', 'Current password', 'current-password')}
        {field('next', 'New password', 'new-password')}
        <p id={`${ids}-rule`} className="-mt-2 text-xs text-slate-600">
          At least {MIN} characters, and different from your current one.
        </p>
        {field('confirm', 'Confirm new password', 'new-password')}
        <label className="flex min-h-11 items-center gap-2 text-sm text-slate-800 sm:min-h-0">
          <input
            type="checkbox"
            checked={show}
            onChange={(e) => setShow(e.target.checked)}
            className="h-5 w-5 accent-slate-900"
          />
          Show passwords
        </label>
      </fieldset>

      {formError && (
        <p
          ref={formErrorRef}
          tabIndex={-1}
          role="alert"
          className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800"
        >
          {formError}
        </p>
      )}
      <button ref={submitRef} type="submit" disabled={busy} className={`mt-3 ${buttonPrimary}`}>
        {busy ? 'Changing…' : 'Change password'}
      </button>
      <p role="status" className="mt-2 min-h-5 text-sm text-emerald-800">
        {status}
      </p>
    </form>
  )
}
