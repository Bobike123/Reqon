import { Link } from 'react-router-dom'
import { PageHeader } from '../ui/PageHeader.tsx'
import { pageMain } from '../ui/layout.ts'

// Any address that is not a screen. Without this, React Router matched nothing
// and the page rendered as the header above an empty space — a dead end with no
// way out, reached by a typo, an old bookmark, or a link to a screen that has
// since been removed.
export default function NotFound() {
  return (
    <main id="main-content" tabIndex={-1} className={pageMain('reading')}>
      <PageHeader
        title="That screen does not exist"
        description="The address you opened is not part of Reqon. It may be a typo, or a bookmark from an older version."
      />
      <p className="text-sm text-slate-700">
        Pick a screen from the menu above, or{' '}
        <Link
          to="/"
          className="rounded font-medium text-slate-900 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
        >
          go to Now
        </Link>
        .
      </p>
    </main>
  )
}
