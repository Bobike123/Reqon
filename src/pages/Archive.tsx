import { useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { canArchiveTask } from '../auth/permissions.ts'
import { departmentChoices } from '../departments/filter.ts'
import { useMembers } from '../data/useMembers.ts'
import { useSubteams } from '../data/useSubteams.ts'
import { useTaskActor } from '../data/useTaskActor.ts'
import { NO_DEPARTMENT, useArchivedTasks, useProposalHistory, useSourceProposals, useTasksBySource } from '../data/useTaskHistory.ts'
import { useRestoreTask } from '../data/useTasks.ts'
import { TASK_STATES } from '../tasks/taskState.ts'
import type { Task } from '../tasks/types.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { pageMain } from '../ui/layout.ts'
import { PageHeader } from '../ui/PageHeader.tsx'
import { ActionError, ErrorState } from '../ui/states.tsx'
import { archiveParamsToSearch, hasActiveFilters, pageCount, parseArchiveParams, PROPOSAL_STATUSES, toProposalQuery, toTaskQuery, type ArchiveParams } from './archive/archiveParams.ts'
import { ArchivedTaskRow, HistoryProposalRow } from './archive/ArchiveRows.tsx'
import { useRealtimeTasks } from '../data/useRealtimeTasks.ts'
import { useRealtimeProposals } from '../data/useRealtimeProposals.ts'

const FIELD =
  'mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'
const LABEL = 'block text-xs font-medium text-slate-600'
const STATUS_LABEL: Record<string, string> = { approved: 'Approved', rejected: 'Rejected', other: 'Decided (outcome not recorded)' }

// The history of the season: archived tasks and proposals that are no longer
// live (approved, rejected, decided). Reading it needs no write privilege. Data
// is fetched a page at a time, filtered in the database, so a long history never
// loads into an active screen. Nothing here can delete anything; a task is only
// ever restored, by someone who may.
export default function Archive() {
  useRealtimeTasks()
  useRealtimeProposals()
  const [search, setSearch] = useSearchParams()
  const { value, notice } = useMemo(() => parseArchiveParams(search), [search])
  const members = useMembers()
  const departments = useSubteams()
  const actor = useTaskActor()
  const restore = useRestoreTask()
  const [restoring, setRestoring] = useState<Task | null>(null)
  const [message, setMessage] = useState('')
  const [draft, setDraft] = useState(value.search)
  const searchBox = useRef<HTMLInputElement>(null)

  const tasksQuery = useArchivedTasks(toTaskQuery(value))
  const proposalsQuery = useProposalHistory(toProposalQuery(value))
  const active = value.tab === 'tasks' ? tasksQuery : proposalsQuery
  const rows = active.data?.rows ?? []
  const total = active.data?.total ?? 0
  const pages = pageCount(total)

  const taskSources = useSourceProposals(value.tab === 'tasks' ? (tasksQuery.data?.rows ?? []).map((t) => t.source_proposal).filter((id): id is string => id !== null) : [])
  const proposalTasks = useTasksBySource(value.tab === 'proposals' ? (proposalsQuery.data?.rows ?? []).map((p) => p.id) : [])

  const memberName = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.full_name])), [members.data])
  const deptList = useMemo(() => departments.data ?? [], [departments.data])
  const deptName = useMemo(() => new Map(deptList.map((d) => [d.key, d.name])), [deptList])
  // History keeps every department name resolvable, archived ones included.
  const deptOptions = useMemo(() => departmentChoices(deptList, new Set(deptList.map((d) => d.key))), [deptList])

  const go = (patch: Partial<ArchiveParams>, resetPage = true) =>
    setSearch(archiveParamsToSearch({ ...value, ...patch, page: resetPage ? 0 : (patch.page ?? value.page) }), { replace: true })

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    go({ search: draft })
  }

  const error = active.error ?? members.error ?? departments.error
  const filtered = hasActiveFilters(value)

  async function confirmRestore() {
    if (!restoring) return
    try {
      const row = await restore.mutateAsync({ id: restoring.id })
      setMessage(
        restoring.state === 'done'
          ? `“${restoring.title}” is back on the Board in To do, reopened. Its history is kept.`
          : `“${restoring.title}” is back on the Board (${row.state}). Its history is kept.`,
      )
      setRestoring(null)
    } catch {
      // The error is shown in the dialog by ActionError; nothing else changes.
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className={pageMain()}>
      <PageHeader title="Archive" description="Work that is no longer live: archived tasks, and proposals that were approved, rejected or decided. Everyone can read it; nothing here is deleted." />

      <div role="group" aria-label="What to browse" className="mb-3 flex flex-wrap gap-1 rounded-md bg-slate-50 p-1" data-testid="archive-tabs">
        {(['tasks', 'proposals'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            aria-pressed={value.tab === tab}
            onClick={() => setSearch(archiveParamsToSearch({ tab, department: '', owner: '', state: '', search: '', id: '', page: 0 }), { replace: true })}
            className={`min-h-11 rounded px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:outline-none sm:min-h-0 ${value.tab === tab ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
          >
            {tab === 'tasks' ? 'Archived tasks' : 'Proposal history'}
          </button>
        ))}
      </div>

      {notice && (
        <p role="status" className="mb-3 rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900" data-testid="archive-notice">
          {notice}
        </p>
      )}
      {message && (
        <p role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded bg-emerald-50 p-2 text-sm text-emerald-900" data-testid="archive-message">
          {message}{' '}
          <Link to="/board" className="inline-flex min-h-11 items-center font-medium underline underline-offset-2 sm:min-h-0">
            Open the Board
          </Link>
        </p>
      )}

      <form onSubmit={submitSearch} className="mb-3 space-y-3 rounded-lg border border-slate-200 bg-white p-3" data-testid="archive-filters" data-tutorial="archive-filters" role="search" aria-label="Filter the archive">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <label htmlFor="archive-q" className={LABEL}>
              Search titles
            </label>
            <div className="mt-1 flex gap-2">
              <input id="archive-q" ref={searchBox} type="search" value={draft} onChange={(e) => setDraft(e.target.value)} className={`${FIELD} mt-0`} />
              <button type="submit" className={buttonPrimary}>
                Search
              </button>
            </div>
          </div>
          <div>
            <label htmlFor="archive-dept" className={LABEL}>
              Department
            </label>
            <select id="archive-dept" value={value.department} onChange={(e) => go({ department: e.target.value })} className={FIELD}>
              <option value="">All departments</option>
              <option value={NO_DEPARTMENT}>No department (older work)</option>
              {deptOptions.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="archive-owner" className={LABEL}>
              {value.tab === 'tasks' ? 'Owner' : 'Proposed owner'}
            </label>
            <select id="archive-owner" value={value.owner} onChange={(e) => go({ owner: e.target.value })} className={FIELD}>
              <option value="">Anyone</option>
              {(members.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name}
                  {m.status === 'alumni' ? ' (former member)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="archive-state" className={LABEL}>
              {value.tab === 'tasks' ? 'State when archived' : 'Outcome'}
            </label>
            <select id="archive-state" value={value.state} onChange={(e) => go({ state: e.target.value })} className={FIELD}>
              <option value="">Any</option>
              {value.tab === 'tasks'
                ? TASK_STATES.map((s) => (
                    <option key={s.state} value={s.state}>
                      {s.label}
                    </option>
                  ))
                : PROPOSAL_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
            </select>
          </div>
        </div>
        <p className="flex flex-wrap items-center gap-2 text-xs text-slate-600" role="status" data-testid="archive-summary">
          <span>{active.isLoading ? 'Loading…' : `${total} ${total === 1 ? 'item' : 'items'}${filtered ? ' match these filters' : ''} · page ${value.page + 1} of ${pages}`}</span>
          {filtered && (
            <button
              type="button"
              onClick={() => {
                setDraft('')
                setSearch(archiveParamsToSearch({ tab: value.tab, department: '', owner: '', state: '', search: '', id: '', page: 0 }), { replace: true })
              }}
              className="inline-flex min-h-11 items-center rounded font-medium text-slate-900 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:outline-none sm:min-h-0"
            >
              Clear filters
            </button>
          )}
        </p>
      </form>

      {error ? (
        <ErrorState title="Could not load the archive" error={error} onRetry={() => void active.refetch()} />
      ) : (
        <>
          {!active.isLoading && rows.length === 0 && (
            <p className="rounded border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600" data-testid="archive-empty">
              {filtered ? 'Nothing in the archive matches these filters.' : value.tab === 'tasks' ? 'No task has been archived yet. Done tasks are archived automatically a day after they are finished.' : 'No proposal has been decided yet.'}
            </p>
          )}

          <ul className="space-y-2" data-testid="archive-list" data-tutorial="archive-list" aria-busy={active.isFetching}>
            {value.tab === 'tasks'
              ? (tasksQuery.data?.rows ?? []).map((task) => (
                  <ArchivedTaskRow
                    key={task.id}
                    task={task}
                    departmentName={task.subteam_key ? (deptName.get(task.subteam_key) ?? task.subteam_key) : null}
                    ownerName={task.owner_id ? (memberName.get(task.owner_id) ?? 'Someone no longer on the roster') : null}
                    source={task.source_proposal ? (taskSources.data?.get(task.source_proposal) ?? null) : null}
                    canRestore={actor !== null && canArchiveTask(actor, task)}
                    restoring={restore.isPending && restoring?.id === task.id}
                    onRestore={setRestoring}
                    memberNames={memberName}
                  />
                ))
              : (proposalsQuery.data?.rows ?? []).map((proposal) => (
                  <HistoryProposalRow
                    key={proposal.id}
                    proposal={proposal}
                    departmentName={proposal.subteam_key ? (deptName.get(proposal.subteam_key) ?? proposal.subteam_key) : null}
                    ownerName={proposal.owner_id ? (memberName.get(proposal.owner_id) ?? 'Someone no longer on the roster') : null}
                    task={proposalTasks.data?.get(proposal.id) ?? null}
                    memberNames={memberName}
                  />
                ))}
          </ul>

          {pages > 1 && (
            <nav aria-label="Archive pages" className="mt-3 flex items-center gap-3">
              <button type="button" className={buttonSecondary} disabled={value.page === 0} onClick={() => go({ page: value.page - 1 }, false)}>
                Previous
              </button>
              <span className="text-sm text-slate-700" data-testid="archive-page">
                Page {value.page + 1} of {pages}
              </span>
              <button type="button" className={buttonSecondary} disabled={value.page + 1 >= pages} onClick={() => go({ page: value.page + 1 }, false)}>
                Next
              </button>
            </nav>
          )}
        </>
      )}

      <RestoreDialog task={restoring} pending={restore.isPending} error={restore.error} onCancel={() => { restore.reset(); setRestoring(null) }} onConfirm={() => void confirmRestore()} />
    </main>
  )
}

function RestoreDialog({ task, pending, error, onCancel, onConfirm }: { task: Task | null; pending: boolean; error: Error | null; onCancel: () => void; onConfirm: () => void }) {
  const titleId = 'restore-title'
  return (
    <Dialog open={task !== null} onClose={onCancel} labelledBy={titleId} dismissible={!pending}>
      {task && (
        <div>
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            Restore “{task.title}”?
          </h2>
          <p className="mt-2 text-sm text-slate-700">
            {task.state === 'done'
              ? 'This task was finished. Restoring it reopens it: it goes back to the Board in To do, and its completion time is cleared so it is not archived again straight away.'
              : 'Restoring puts it back on the Board in the lane it was in.'}{' '}
            Its history is kept either way. Only its department Head or a Developer can restore it.
          </p>
          <ActionError error={error} className="mt-3" />
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button type="button" className={buttonSecondary} disabled={pending} onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className={buttonPrimary} disabled={pending} onClick={onConfirm} data-testid="restore-confirm">
              {pending ? 'Restoring…' : 'Restore task'}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
