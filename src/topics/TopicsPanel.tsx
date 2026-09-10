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

// The topic workspace. BOTH the Now screen and the Meetings screen render this
// exact component, so raising, agendaing, deciding and converting behave the
// same wherever you are. There is deliberately no second implementation.
export function TopicsPanel({
  heading,
  states,
  emptyHint,
}: {
  heading: string
  // Which lifecycle states to show. Now shows the live ones; Meetings shows
  // everything including the archive.
  states?: TopicState[]
  emptyHint: string
}) {
  const topics = useTopics()
  const members = useMembers()
  const tasks = useTasks()
  const createTopic = useCreateTopic()
  const updateTopic = useUpdateTopic()
  const convert = useConvertTopicToTask()
  const [convertingId, setConvertingId] = useState<string | null>(null)

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

  return (
    <section aria-labelledby="topics-heading" data-tutorial="topics-panel">
      <h2 id="topics-heading" className="mb-2 text-sm font-semibold text-slate-900">
        {heading}
      </h2>

      <RaiseTopicForm
        onRaise={onRaise}
        pending={createTopic.isPending}
        error={createTopic.error ? createTopic.error.message : null}
      />

      {writeError && (
        <p role="alert" className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          Could not save that change: {writeError.message}
        </p>
      )}
      {updateTopic.isPending && (
        <p role="status" className="mt-2 text-xs text-slate-500">
          Saving…
        </p>
      )}

      {topics.error && (
        <div className="mt-2">
          <ErrorState
            title="Could not load topics"
            error={topics.error}
            onRetry={() => void topics.refetch()}
          />
        </div>
      )}

      {!topics.isLoading && visible.length === 0 && (
        <p className="mt-2 rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          {emptyHint}
        </p>
      )}

      <ul className="mt-2 space-y-2" data-testid="topic-list">
        {visible.map((topic) => (
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
          />
        ))}
      </ul>
    </section>
  )
}
