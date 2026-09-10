import { useState, type FormEvent } from 'react'

// Shared by the Now screen and the Meetings screen. Anyone can raise a topic
// from wherever they happen to be standing.
export function RaiseTopicForm({
  onRaise,
  pending,
  error,
}: {
  onRaise: (title: string, context: string | null) => Promise<void>
  pending: boolean
  error: string | null
}) {
  const [title, setTitle] = useState('')
  const [context, setContext] = useState('')
  const [justRaised, setJustRaised] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Guard against a double submit (Enter twice, or a second click before the
    // first insert returns).
    if (pending || !title.trim()) return
    await onRaise(title.trim(), context.trim() || null)
    setTitle('')
    setContext('')
    setJustRaised(true)
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-slate-200 bg-white p-3">
      <label htmlFor="topic-title" className="block text-xs font-medium text-slate-600">
        Raise a topic
      </label>
      <input
        id="topic-title"
        value={title}
        onChange={(e) => {
          setTitle(e.target.value)
          setJustRaised(false)
        }}
        placeholder="What needs deciding?"
        className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
      />
      <label htmlFor="topic-context" className="mt-2 block text-xs font-medium text-slate-600">
        Context (optional)
      </label>
      <input
        id="topic-context"
        value={context}
        onChange={(e) => setContext(e.target.value)}
        placeholder="Why it matters, or the rule it relates to"
        className="mt-1 min-h-11 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || !title.trim()}
          className="min-h-11 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
        >
          {pending ? 'Raising…' : 'Raise topic'}
        </button>
        {justRaised && !pending && !error && (
          <span role="status" className="pc-fade-in text-sm text-green-700">
            Topic raised.
          </span>
        )}
        {error && (
          <span role="alert" className="text-sm text-red-700">
            {error}
          </span>
        )}
      </div>
    </form>
  )
}
