import { PageHeader } from '../ui/PageHeader.tsx'
import { pageMain } from '../ui/layout.ts'
import { ProposalsPanel } from '../proposals/ProposalsPanel.tsx'

// Suggested work that is not yet an official task. This screen used to be
// called "Meetings", which is what it never was: real meetings now have their
// own screen, and this one has the name it always deserved.
//
// It renders the same ProposalsPanel the Now screen does — same form, same
// cards, same actions — laid out for a big screen: the suggestion form and the
// running tally stay on the left while the proposals fill the rest.
export default function Proposals() {
  return (
    <main id="main-content" tabIndex={-1} className={pageMain()}>
      <PageHeader
        title="Task proposals"
        description="Work anyone can suggest. The President, Vice President or a Developer decides what becomes an official board task."
      />

      <ProposalsPanel
        layout="wide"
        heading="Proposals"
        emptyHint="Nothing suggested yet. Suggest the first thing above — anything the club should take on."
      />
    </main>
  )
}
