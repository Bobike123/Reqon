import { BookReader } from '../book/BookReader.tsx'
import { readPageParam } from '../book/source.ts'
import { useRegulationDocument } from '../data/useRegulationDocument.ts'
import { mergeSearchParams } from '../lib/searchParams.ts'
import { useSeason } from '../season/context.ts'
import { PageHeader } from '../ui/PageHeader.tsx'
import { pageMain } from '../ui/layout.ts'
import { useUrlParams } from '../lib/useUrlParams.ts'

// The Requirements Book on its own screen: the same reader the Register opens
// beside its rules (book/BookReader.tsx), with the page kept in the address so
// existing links (/book?page=N&ref=…) keep working and a refresh keeps the page.
export default function Book() {
  const season = useSeason()
  const regsRef = season.status === 'ready' ? (season.season.regs_ref ?? null) : null
  const doc = useRegulationDocument(regsRef)
  const [params, setParams] = useUrlParams()

  const pageCount = doc.data?.page_count ?? null
  const { page, notice } = readPageParam(params.get('page'), pageCount)
  const ruleRef = params.get('ref')?.slice(0, 60) || null

  return (
    <main id="main-content" tabIndex={-1} className={pageMain('wide')}>
      <div data-tutorial="book-header">
        <PageHeader
          title="Requirements Book"
          description={regsRef ? `The regulations for this season (${regsRef}).` : 'The regulations document for this season.'}
        />
      </div>
      <div data-tutorial="book-actions">
        <BookReader
          page={page}
          notice={notice}
          ruleRef={ruleRef}
          note={ruleRef && page === null && !notice ? 'Page not recorded for this rule' : null}
          onPageChange={(next) => setParams((current) => mergeSearchParams(current, { page: String(next) }), { replace: true })}
        />
      </div>
    </main>
  )
}
