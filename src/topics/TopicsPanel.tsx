import { useCallback, useMemo, useState } from 'react'
import { useMembers } from '../data/useMembers.ts'
import { useTasks } from '../data/useTasks.ts'
import {
  useConvertTopicToTask,
  useCreateTopic,
  useTopics,
  useUpdateTopic,
  type Topic,
  type TopicState,
} from '../data/useTopics.ts'
import { ErrorState } from '../ui/states.tsx'
import { RaiseTopicForm } from './RaiseTopicForm.tsx'
import { TopicCard } from './TopicCard.tsx'
import { TOPIC_STATES } from './topicStates.ts'

// The topic workspace. BOTH the Now screen and the Meetings screen render this
// exact component, so raising, agendaing, deciding and converting behave the
// same wherever you are. There is deliberately no second implementation.
export function TopicsPanel({
  heading,
  states,
  emptyHint,
  layout = 'stack',
}: {
  heading: string
  // Which lifecycle states to show. Now shows the live ones; Meetings shows
  // everything including the archive.
  states?: TopicState[]
  emptyHint: string
  // 'stack' is one column: the Now screen, and every screen on a phone.
  // 'wide' is for a meeting on a big screen: the form and a running tally stay
  // in a left-hand column while the cards fill the rest of the width.
  layout?: 'stack' | 'wide'
}) {
  const topics = useTopics()
  const members = useMembers()
  const tasks = useTasks()
  const createTopic = useCreateTopic()
  const updateTopic = useUpdateTopic()
  const convert = useConvertTopicToTask()
  const [convertingId, setConvertingId] = useState<string | null>(null)
  const wide = layout === 'wide'

  const tasksByTopic = useMemo(() => {
    const map = new Map<string, (typeof tasks.data extends undefined ? never : NonNullable<typeof tasks.data>)[number]>()
    for (const task of tasks.data ?? []) {
      if (task.source_topic) map.set(task.source_topic, task)
    }
    return map
  }, [tasks.data])

  const visible = useMemo(() => {
    const all = topics.data ?? []
    return states ? all.filter((t) => states.includes(t.state)) : all
  }, [topics.data, states])

  const onRaise = useCallback(
    async (title: string, context: string | null) => {
      await createTopic.mutateAsync({ title, context })
    },
    [createTopic],
  )

  const onSetState = useCallback(
    (id: string, state: TopicState) => updateTopic.mutate({ id, state }),
    [updateTopic],
  )
  const onSetDecision = useCallback(
    (id: string, decision: string) => updateTopic.mutate({ id, decision: decision || null }),
    [updateTopic],
  )
  const onSetOwner = useCallback(
    (id: string, ownerId: string | null) => updateTopic.mutate({ id, ownerId }),
    [updateTopic],
  )
  const onConvert = useCallback(
    (topic: Topic) => {
      setConvertingId(topic.id)
      convert.mutate(topic, { onSettled: () => setConvertingId(null) })
    },
    [convert],
  )

  const writeError = updateTopic.error ?? convert.error

  const raise = (
    <RaiseTopicForm
      onRaise={onRaise}
      pending={createTopic.isPending}
      error={createTopic.error ? createTopic.error.message : null}
    />
  )

  const list = (
    <div className={wide ? 'mt-3 space-y-2 lg:mt-0' : 'mt-2 space-y-2'}>
      {writeError && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          Could not save that change: {writeError.message}
        </p>
      )}
      {updateTopic.isPending && (
        <p role="status" className="text-xs text-slate-500">
          Saving…
        </p>
      )}

      {topics.error && (
        <ErrorState
          title="Could not load topics"
          error={topics.error}
          onRetry={() => void topics.refetch()}
        />
      )}

      {!topics.isLoading && visible.length === 0 && (
        <p className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          {emptyHint}
        </p>
      )}

      <ul
        className={wide ? 'grid items-start gap-3 xl:grid-cols-2 min-[100rem]:grid-cols-3' : 'space-y-2'}
        data-testid="topic-list"
      >
        {visible.map((topic, index) => (
          <TopicCard
            key={topic.id}
            topic={topic}
            members={members.data ?? []}
            taskFromTopic={tasksByTopic.get(topic.id)}
            converting={convertingId === topic.id && convert.isPending}
            onSetState={onSetState}
            onSetDecision={onSetDecision}
            onSetOwner={onSetOwner}
            onConvert={onConvert}
            tutorial={index === 0}
          />
        ))}
      </ul>
    </div>
  )

  return (
    <section aria-labelledby="topics-heading" data-tutorial="topics-panel">
      <h2 id="topics-heading" className="mb-2 text-sm font-semibold text-slate-900">
        {heading}
      </h2>

      {wide ? (
        <div className="lg:grid lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)] lg:items-start lg:gap-6">
          <div className="space-y-3 lg:sticky lg:top-4">
            {raise}
            <TopicTally topics={visible} converted={tasksByTopic.size} />
          </div>
          {list}
        </div>
      ) : (
        <>
          {raise}
          {list}
        </>
      )}
    </section>
  )
}

// Where every topic stands, as plain numbers. Deliberately not a set of
// filters: a card that vanished the moment someone changed its state would
// pull the discussion out from under the room.
function TopicTally({ topics, converted }: { topics: Topic[]; converted: number }) {
  const count = (state: TopicState) => topics.filter((t) => t.state === state).length
  const flow = TOPIC_STATES.filter((s) => s.value !== 'parked')
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3" data-tutorial="topic-flow">
      <h3 className="text-xs font-medium text-slate-600">How a topic moves</h3>
      <ol className="mt-2 space-y-1 text-sm">
        {flow.map((state, index) => (
          <li key={state.value} className="flex items-baseline justify-between gap-3">
            <span className="text-slate-800">
              <span className="text-slate-500">{index + 1}.</span> {state.label}
            </span>
            <span className="text-slate-700 tabular-nums">
              {count(state.value)}
              <span className="sr-only"> topics</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-pretty text-slate-600">
        Write the decision on the card, then press “Convert to task” to put it on the Board.{' '}
        <span className="tabular-nums">{converted}</span> converted so far. Parked topics (
        <span className="tabular-nums">{count('parked')}</span>) are set aside, not deleted.
      </p>
    </div>
  )
}
