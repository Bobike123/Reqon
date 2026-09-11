import type { ReactNode } from 'react'
import Login from '../pages/Login.tsx'
import { useAuth } from './context.ts'

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
        {children}
      </div>
    </main>
  )
}

// The only way into the app. Everything it wraps is unreachable until the
// database has confirmed the caller is on the club roster.
//
// This is a usability gate, not the security boundary — RLS is. Even if
// somebody edited this component in their browser, every query would still
// come back empty.
export default function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth()

  if (auth.status === 'loading') {
    return (
      <Centered>
        <p role="status" className="text-slate-600">
          Checking your account…
        </p>
      </Centered>
    )
  }

  if (auth.status === 'signedOut') {
    return <Login />
  }

  if (auth.status === 'error') {
    return (
      <Centered>
        <h1 className="text-lg font-semibold text-slate-900">
          Could not check your account
        </h1>
        <p role="alert" className="mt-2 text-sm text-slate-600">
          {auth.message}
        </p>
        <button
          type="button"
          onClick={auth.retry}
          className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => void auth.signOut()}
          className="mt-2 block w-full text-sm text-slate-500 underline"
        >
          Sign out
        </button>
      </Centered>
    )
  }

  if (auth.status === 'notRostered') {
    return (
      <Centered>
        <h1 className="text-lg font-semibold text-slate-900">No access</h1>
        <p className="mt-2 text-slate-700">
          Your account is not on the club roster; ask the president or vice-president to add you.
        </p>
        <button
          type="button"
          onClick={() => void auth.signOut()}
          className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Sign out
        </button>
      </Centered>
    )
  }

  return <>{children}</>
}
