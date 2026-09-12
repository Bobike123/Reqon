import { PageHeader } from '../ui/PageHeader.tsx'
import { pageMain } from '../ui/layout.ts'
import { TopicsPanel } from '../topics/TopicsPanel.tsx'

// The Meetings screen is the topic workspace. It renders the same TopicsPanel
// the Now screen does — same form, same cards, same actions. Anything that
// works here works there, because it is literally the same component. Here it
// is laid out for a big screen: the form and the running totals stay on the
// left while the topics fill the rest of the width.
export default function Meetings() {
  return (
    <main id="main-content" tabIndex={-1} className={pageMain()}>
      <PageHeader
        title="Meetings"
        description="Raise a topic, put it on the agenda, record the decision — then turn it into a task."
      />

      <TopicsPanel
        layout="wide"
        heading="Topics"
        emptyHint="No topics yet. Raise one above — anything that needs a decision from the team."
      />
    </main>
  )
}
