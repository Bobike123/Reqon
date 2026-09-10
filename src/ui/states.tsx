import type { ReactNode } from 'react'

// The three states every screen owes the reader, in one place so no screen
// invents its own wording or forgets the way out of an error.

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" className="py-6 text-center text-sm text-slate-600">
      {label}
    </p>
  )
}

// An error the user can act on. `onRetry` is not optional by accident: a data
// error with no way back is a dead end, and dead ends are what this phase is
// for.
export function ErrorState({
  title,
  error,
  onRetry,
}: {
  title: string
  error: Error
  onRetry: () => void
}) {
  return (
    <div className="rounded-lg border border-red-300 bg-red-50 p-4">
      <h2 className="text-sm font-semibold text-red-900">{title}</h2>
      <p role="alert" className="mt-1 text-sm text-red-800">
        {error.message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 min-h-11 rounded bg-red-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-900 sm:min-h-0"
      >
        Try again
      </button>
    </div>
  )
}

// Empty is not the same as broken. Say what would put something here.
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center">
      <p className="font-medium text-slate-800">{title}</p>
      <p className="mt-1 text-sm text-slate-600">{children}</p>
    </div>
  )
}
