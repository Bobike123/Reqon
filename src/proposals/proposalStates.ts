import type { TopicState } from '../data/useTopics.ts'

// A topic's stages in the order a topic moves through them, with the words
// people see. Shared by the card's dropdown and the tally on Meetings.
export const TOPIC_STATES: { value: TopicState; label: string }[] = [
  { value: 'open', label: 'Raised' },
  { value: 'agenda', label: 'On the agenda' },
  { value: 'decided', label: 'Decided' },
  { value: 'parked', label: 'Parked' },
]
