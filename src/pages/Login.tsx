import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/context.ts'

// Accounts are created by the board in the Supabase dashboard. There is
// deliberately no sign-up link here, and no password-reset link: password
// reset needs a configured mailer, and a link that goes nowhere is worse than
// no link. Ask the board to reset it for you.
export default function Login() {
  const { signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await signIn(email, password)
    if (result.error) {
      setError(result.error)
      setBusy(false)
    }
    // On success the auth state change swaps this screen out, so there is
    // nothing to do here and no setBusy(false) — the component unmounts.
  }

  return (
    <main id="main-content" tabIndex={-1} className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-xl font-semibold text-slate-900">Paddock Control</h1>
        <p className="mt-1 mb-6 text-sm text-slate-600">
          Sign in with your club account.
        </p>

        <label htmlFor="email" className="block text-sm font-medium text-slate-700">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 mb-4 w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus-visible:border-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
        />

        <label htmlFor="password" className="block text-sm font-medium text-slate-700">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 mb-4 w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus-visible:border-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
        />

        {error && (
          <p role="alert" className="mb-4 text-sm text-red-700">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-60"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="mt-4 text-xs text-slate-500">
          No account? The board creates them — there is no public sign-up.
        </p>
      </form>
    </main>
  )
}
