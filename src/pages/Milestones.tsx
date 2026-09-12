import { PageHeader } from '../ui/PageHeader.tsx'
import { formatDay } from '../lib/dates.ts'
import { pageMain } from '../ui/layout.ts'
import { EmptyState, ErrorState } from '../ui/states.tsx'
import { useClauses } from '../data/useClauses.ts'
import {
  useMilestones,
  useMilestoneSections,
  useSetSectionDrafted,
} from '../data/useMilestones.ts'
import {
  draftedCount,
  sectionsFor,
  submissionWindow,
} from './milestones/milestoneModel.ts'

export default function Milestones() {
  const milestones = useMilestones()
  const sections = useMilestoneSections()
  const clauses = useClauses()
  const setDrafted = useSetSectionDrafted()

  // The Art. F.14 format rules are rendered straight from the clause rows that
  // were imported from the regulations PDF. They are NOT retyped here from
  // memory, so nothing can be silently "corrected" into being wrong.
  const formatClauses = (clauses.data ?? [])
    .filter((c) => c.printed_ref.startsWith('F.14.2'))
    .sort((a, b) => a.printed_ref.localeCompare(b.printed_ref))
  const penaltyClauses = (clauses.data ?? [])
    .filter((c) => c.printed_ref.startsWith('F.14.3') || c.printed_ref.startsWith('F.14.4'))
    .sort((a, b) => a.printed_ref.localeCompare(b.printed_ref))

  const error = milestones.error ?? sections.error
  if (error) {
    return (
      <main id="main-content" tabIndex={-1} className={pageMain()}>
        <h1 className="text-xl font-semibold text-slate-900">Milestones</h1>
        <div className="mt-4">
          <ErrorState
            title="Could not load milestones"
            error={error}
            onRetry={() => {
              void milestones.refetch()
              void sections.refetch()
            }}
          />
        </div>
      </main>
    )
  }

  const totalPoints = (milestones.data ?? [])
    .filter((m) => m.key.startsWith('MS1'))
    .reduce((n, m) => n + (m.max_points ?? 0), 0)

  return (
    <main id="main-content" tabIndex={-1} className={pageMain()}>
      <PageHeader
        title="Milestones"
        description="The MS1 deliverables: submission windows, points and section checklists."
      />

      {milestones.isLoading && (
        <p role="status" className="mb-2 text-xs text-slate-500">Loading…</p>
      )}
      {setDrafted.isError && (
        <p role="alert" className="mb-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">
          Could not save that change: {setDrafted.error.message}
        </p>
      )}

      <p className="mb-3 text-sm text-slate-600" data-testid="ms1-total">
        MS1 deliverables — {totalPoints} points in total
      </p>

      {!milestones.isLoading && (milestones.data ?? []).length === 0 && (
        <EmptyState title="No milestones for this season yet">
          The President or Vice President adds the submission windows and points in
          Settings → Milestone dates and points.
        </EmptyState>
      )}

      {/* Two milestones side by side on a wide screen. */}
      <ul className="grid items-start gap-3 xl:grid-cols-2">
        {(milestones.data ?? []).map((milestone, index) => {
          const window = submissionWindow(milestone, new Date())
          const mySections = sectionsFor(sections.data ?? [], milestone.key)
          const { drafted, total } = draftedCount(mySections)

          return (
            <li
              key={milestone.key}
              className="rounded-lg border border-slate-200 bg-white p-3"
              data-testid={`milestone-${milestone.key}`}
              data-tutorial={index === 0 ? 'milestone-card' : undefined}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">
                  <span className="font-mono">{milestone.key}</span> — {milestone.name}
                </h2>
                <span className="text-sm text-slate-700" data-testid={`points-${milestone.key}`}>
                  {milestone.max_points} points
                </span>
              </div>

              {milestone.aim && <p className="mt-1 text-sm text-slate-600">{milestone.aim}</p>}

              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                {window.kind === 'tbc' ? (
                  <span
                    className="rounded bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700"
                    data-testid={`window-${milestone.key}`}
                    title="No submission window has been published for this milestone yet"
                  >
                    Window: TBC
                  </span>
                ) : (
                  <>
                    <span className="text-slate-700" data-testid={`window-${milestone.key}`}>
                      {window.opensOn ? `${formatDay(window.opensOn)} → ` : 'Due '}
                      {formatDay(window.dueOn)}
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        window.passed
                          ? 'bg-red-100 text-red-800'
                          : window.daysRemaining <= 14
                            ? 'bg-amber-100 text-amber-900'
                            : 'bg-slate-100 text-slate-700'
                      }`}
                      data-testid={`days-${milestone.key}`}
                    >
                      {window.passed
                        ? `${Math.abs(window.daysRemaining)} days ago`
                        : `${window.daysRemaining} days remaining`}
                    </span>
                  </>
                )}
                {milestone.is_blocking && (
                  <span className="rounded bg-red-700 px-2 py-0.5 text-xs font-bold text-white" title="Missing this bars the team from on-track activity">
                    BLOCKING
                  </span>
                )}
                {milestone.article_ref && (
                  <span className="font-mono text-xs text-slate-500">{milestone.article_ref}</span>
                )}
              </div>

              {mySections.length > 0 && (
                <div className="mt-3" data-tutorial={index === 0 ? 'milestone-sections' : undefined}>
                  <p className="text-xs font-medium text-slate-600">
                    Sections drafted{' '}
                    <span data-testid={`sections-${milestone.key}`}>
                      {drafted}/{total}
                    </span>
                  </p>
                  <ul className="mt-1 space-y-1">
                    {mySections.map((section) => (
                      <li key={section.id}>
                        <label className="flex min-h-11 items-center gap-2 text-sm text-slate-800 sm:min-h-0">
                          <input
                            type="checkbox"
                            checked={section.is_drafted}
                            onChange={(e) =>
                              setDrafted.mutate({ id: section.id, isDrafted: e.target.checked })
                            }
                            className="h-5 w-5 accent-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                          />
                          {section.name}
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {/* Static reference, read from the imported clause rows. */}
      <section className="mt-8 max-w-6xl" aria-labelledby="format-heading" data-tutorial="milestone-format">
        <h2 id="format-heading" className="mb-1 text-sm font-semibold text-slate-900">
          Deliverable format — Art. F.14
        </h2>
        <p className="mb-2 text-xs text-slate-500">
          Straight from the regulations import. If this disagrees with something you were
          told, the book wins.
        </p>
        <table className="w-full table-auto border-collapse text-sm">
          <caption className="sr-only">Art. F.14 deliverable format requirements</caption>
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th scope="col" className="w-24 py-1 pr-2 font-medium text-slate-600">Rule</th>
              <th scope="col" className="py-1 font-medium text-slate-600">Requirement</th>
            </tr>
          </thead>
          <tbody data-testid="format-table">
            {formatClauses.map((c) => (
              <tr key={c.clause_key} className="border-b border-slate-100 align-top">
                <th scope="row" className="py-1.5 pr-2 text-left font-mono text-xs font-normal text-slate-500">
                  {c.printed_ref}
                </th>
                <td className="py-1.5 whitespace-pre-line text-slate-800">{c.body}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 className="mt-4 mb-1 text-sm font-semibold text-slate-900">
          What it costs you to get it wrong
        </h3>
        <table className="w-full table-auto border-collapse text-sm">
          <caption className="sr-only">Art. F.14 penalties</caption>
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th scope="col" className="w-24 py-1 pr-2 font-medium text-slate-600">Rule</th>
              <th scope="col" className="py-1 font-medium text-slate-600">Consequence</th>
            </tr>
          </thead>
          <tbody data-testid="penalty-table">
            {penaltyClauses.map((c) => (
              <tr key={c.clause_key} className="border-b border-slate-100 align-top">
                <th scope="row" className="py-1.5 pr-2 text-left font-mono text-xs font-normal text-slate-500">
                  {c.printed_ref}
                </th>
                <td className="py-1.5 whitespace-pre-line text-slate-800">{c.body}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  )
}
