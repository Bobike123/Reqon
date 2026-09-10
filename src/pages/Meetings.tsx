import { PageHeader } from '../ui/PageHeader.tsx'
import { TopicsPanel } from '../topics/TopicsPanel.tsx'

// The Meetings screen is the topic workspace. It renders the same TopicsPanel
// the Now screen does — same form, same cards, same actions. Anything that
// works here works there, because it is literally the same component.
export default function Meetings() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-3 py-4 sm:px-6 *:max-w-3xl">
      <PageHeader
        title="Meetings"
        description="Raise a topic, put it on the agenda, record the decision — then turn it into a task."
      />

      <TopicsPanel
        heading="Topics"
        emptyHint="No topics yet. Raise one above — anything that needs a decision from the team."
      />
    </main>
  )
}
