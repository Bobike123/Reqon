import { useAuth } from '../auth/context.ts'

// Placeholder screen. The real Now screen replaces this in a later phase; for
// now it proves who is signed in and that sign-out works.
export default function Home() {
  const auth = useAuth()
  // Unreachable inside <RequireAuth>, but returning null would be a blank
  // page if that ever changed.
  if (auth.status !== 'member') {
    return (
      <main id="main-content" tabIndex={-1} className="p-8">
        <p role="status" className="text-slate-600">Checking your account…</p>
      </main>
    )
  }

  return (
    <main id="main-content" tabIndex={-1} className="flex min-h-screen flex-col items-center justify-center gap-2 bg-white p-8 text-slate-900">
      <h1 className="text-4xl font-semibold tracking-tight">hello</h1>
      <p className="text-slate-600">
        Signed in as {auth.member.full_name}
        {auth.member.is_board ? ' (board)' : ''}
      </p>
      <button
        type="button"
        onClick={() => void auth.signOut()}
        className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
      >
        Sign out
      </button>
    </main>
  )
}
