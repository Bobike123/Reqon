import { Component, type ErrorInfo, type ReactNode } from 'react'

// React unmounts the ENTIRE tree when a render throws. Without a boundary the
// club sees a blank white page and has no idea what happened — the worst
// possible failure for a tool people rely on in a workshop.
//
// This is still a class component: catching render errors has no hook API.
type Props = { children: ReactNode }
type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Left in on purpose: when a student reports "it went blank", the console
    // is the only evidence anyone will have.
    console.error('Reqon crashed while rendering:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-6">
          <h1 className="text-lg font-semibold text-slate-900">Something broke on this screen</h1>
          <p className="mt-2 text-sm text-slate-700">
            The rest of the app still works. Nothing you had saved is lost — Reqon
            writes straight to the database as you go.
          </p>
          <p role="alert" className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs text-slate-700">
            {this.state.error.message}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="min-h-11 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 sm:min-h-0"
            >
              Try again
            </button>
            <a
              href="/"
              className="min-h-11 rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 sm:min-h-0"
            >
              Back to Now
            </a>
          </div>
        </div>
      </main>
    )
  }
}
