import { Link } from 'react-router-dom'
import { useState } from 'react'
import type { Member } from '../data/useMembers.ts'
import type { Task } from '../data/useTasks.ts'
import type { Topic, TopicState } from '../data/useTopics.ts'

// ONE topic card, used by BOTH the Meetings screen and the Now screen.
// Do not fork this for a second screen — the whole point of Prompt 0's rule
// that topics are editable from Now as well is that they behave identically.

const STATES: { value: TopicState; label: string }[] = [
  { value: 'open', label: 'Raised' },
  { value: 'agenda', label: 'On the agenda' },
  { value: 'decided', label: 'Decided' },
  { value: 'parked', label: 'Parked' },
]

type Props = {
  topic: Topic
  members: Member[]
  taskFromTopic?: Task
  converting: boolean
  onSetState: (id: string, state: TopicState) => void
  onSetDecision: (id: string, decision: string) => void
  onSetOwner: (id: string, ownerId: string | null) => void
  onConvert: (topic: Topic) => void
}

export function TopicCard({
  topic,
  members,
  taskFromTopic,
  converting,
  onSetState,
  onSetDecision,
  onSetOwner,
  onConvert,
}: Props) {
  const serverDecision = topic.decision ?? ''
  const [decision, setDecision] = useState(serverDecision)
  const [lastSeen, setLastSeen] = useState(serverDecision)

  // Follow the server if someone else edits, without clobbering local typing.
  if (lastSeen !== serverDecision) {
    setLastSeen(serverDecision)
    setDecision(serverDecision)
  }

  const alreadyConverted = Boolean(taskFromTopic)

  return (
    <li
      className="rounded-lg border border-slate-200 bg-white p-3"
      data-testid={`topic-${topic.id}`}
      data-topic-state={topic.state}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{topic.title}</h3>
        {topic.starred && <span aria-label="Starred">★</span>}
      </div>
      {topic.context && <p className="mt-0.5 text-sm text-slate-600">{topic.context}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`topic-state-${topic.id}`}>
          State for {topic.title}
        </label>
        <select
          id={`topic-state-${topic.id}`}
          value={topic.state}
          onChange={(e) => onSetState(topic.id, e.target.value as TopicState)}
          className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
        >
          {STATES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor={`topic-owner-${topic.id}`}>
          Owner for {topic.title}
        </label>
        <select
          id={`topic-owner-${topic.id}`}
          value={topic.owner_id ?? ''}
          onChange={(e) => onSetOwner(topic.id, e.target.value || null)}
          className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name}
            </option>
          ))}
        </select>
      </div>

      {/* Editable in EVERY state, on purpose. A topic must never become a dead
          end because of the status it happens to be in — you can write the
          decision before marking it decided, and correct it afterwards. */}
      <div className="mt-2">
        <label
          id={`topic-decision-label-${topic.id}`}
          className="block text-xs font-medium text-slate-600"
          htmlFor={`topic-decision-${topic.id}`}
        >
          Decision
        </label>
        <textarea
          id={`topic-decision-${topic.id}`}
          // Explicit association as well as htmlFor: assistive tech and test
          // queries both resolve the name without guessing.
          aria-labelledby={`topic-decision-label-${topic.id}`}
          rows={2}
          value={decision}
          placeholder="What was decided, and why…"
          onChange={(e) => setDecision(e.target.value)}
          onBlur={() => {
            if (decision !== serverDecision) onSetDecision(topic.id, decision)
          }}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {alreadyConverted ? (
          <span
            className="pc-fade-in inline-flex flex-wrap items-center gap-2 rounded bg-slate-100 px-2 py-1 text-xs text-slate-700"
            data-testid={`topic-converted-${topic.id}`}
          >
            Converted to a task: “{taskFromTopic?.title}”
            <Link
              to="/board"
              className="rounded font-medium text-slate-900 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
            >
              Open on Board
            </Link>
          </span>
        ) : (
          <button
            type="button"
            // Disabled while in flight so a second click cannot start a second
            // insert. The mutation is idempotent as well — see
            // useConvertTopicToTask.
            disabled={converting}
            onClick={() => onConvert(topic)}
            data-testid={`convert-${topic.id}`}
            className="min-h-11 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0"
          >
            {converting ? 'Converting…' : 'Convert to task'}
          </button>
        )}
      </div>
    </li>
  )
}
