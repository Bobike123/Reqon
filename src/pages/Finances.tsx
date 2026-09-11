import { useId, useState } from 'react'
import { describeRoles } from '../auth/permissions.ts'
import { usePermissions } from '../auth/usePermissions.ts'
import { isPermissionError } from '../data/errors.ts'
import { useDeleteFinanceEntry, useFinanceEntries, type FinanceEntry } from '../data/useFinances.ts'
import { FinanceEntryDialog } from '../finance/FinanceEntryDialog.tsx'
import { formatDay, formatEuros } from '../finance/money.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { PageHeader } from '../ui/PageHeader.tsx'
import { buttonDanger, buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { ActionError, EmptyState, ErrorState, LoadingState } from '../ui/states.tsx'

// The club's money for the current season.
//
// Who sees what is decided by the database (the finance_* policies in
// 20260106000000_finance_ledger.sql): any privileged role may read, only the
// Treasurer may write, ordinary members get nothing. This screen follows that
// through usePermissions() so nobody is offered a button that would always be
// refused — but it is the database that keeps the money safe.

const MAIN = 'mx-auto max-w-6xl px-3 py-4 sm:px-6 *:max-w-4xl'
const DESCRIPTION = 'Income and expenses for the current season, in euros.'

// A true minus sign, like the entries below — Intl gives a hyphen.
const signedEuros = (cents: number) => (cents < 0 ? `−${formatEuros(-cents)}` : formatEuros(cents))

export default function Finances() {
  const can = usePermissions()
  const entries = useFinanceEntries({ enabled: can.canViewFinances })
  const remove = useDeleteFinanceEntry()
  const [editing, setEditing] = useState<FinanceEntry | 'new' | null>(null)
  const [deleting, setDeleting] = useState<FinanceEntry | null>(null)
  const [message, setMessage] = useState('')
  // A refusal that came back just as this person lost access to finances. The
  // screen then switches to "nothing to show you here"; this keeps the reason
  // their change did not happen on screen, instead of letting it vanish with
  // the dialog it was shown in.
  const [refusal, setRefusal] = useState<Error | null>(null)
  const lastRefusal = refusal ?? (remove.error && isPermissionError(remove.error) ? remove.error : null)
  const deleteTitleId = useId()

  if (!can.canViewFinances) {
    // Reached by typing the address: the menu has no link for this person.
    return (
      <main id="main-content" tabIndex={-1} className={MAIN}>
        <PageHeader title="Finances" description={DESCRIPTION} />
        <ActionError error={lastRefusal} className="mb-3" />
        <p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          Finances are visible to the President, Vice President, Treasurer and Developer. You are
          signed in as {describeRoles(can.roles)}, so there is nothing to show you here. Ask the
          President if you need access.
        </p>
      </main>
    )
  }

  const rows = entries.data ?? []
  const sum = (kind: FinanceEntry['kind']) =>
    rows.filter((r) => r.kind === kind).reduce((total, r) => total + r.amount_cents, 0)
  const income = sum('income')
  const expenses = sum('expense')
  const balance = income - expenses
  const categories = [...new Set(rows.map((r) => r.category).filter((c): c is string => Boolean(c)))].sort()

  const closeDelete = () => {
    remove.reset()
    setDeleting(null)
  }
  async function confirmDelete(entry: FinanceEntry) {
    try {
      await remove.mutateAsync(entry.id)
      setDeleting(null)
      setMessage('Entry deleted.')
    } catch {
      // Shown in the dialog; nothing on screen changes.
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className={MAIN}>
      <PageHeader title="Finances" description={DESCRIPTION}>
        <p className="mt-2 text-sm text-slate-700" data-testid="finance-access">
          {can.canManageFinances
            ? 'You are the Treasurer: you can add, edit and delete entries.'
            : `Read-only for ${describeRoles(can.roles)}. Only the Treasurer can change these entries — the database refuses changes from anyone else.`}
        </p>
      </PageHeader>

      <section aria-label="Totals" className="grid grid-cols-3 gap-2">
        <Total label="Income" value={formatEuros(income)} />
        <Total label="Expenses" value={formatEuros(expenses)} />
        <Total label="Balance" value={signedEuros(balance)} tone={balance < 0 ? 'text-red-700' : 'text-slate-900'} />
      </section>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Entries</h2>
        {can.canManageFinances && (
          <button
            type="button"
            className={buttonPrimary}
            onClick={() => {
              setMessage('')
              setEditing('new')
            }}
          >
            Add entry
          </button>
        )}
      </div>
      <p role="status" className="mt-1 min-h-5 text-sm text-emerald-800">
        {message}
      </p>

      <div className="mt-1">
        {entries.error ? (
          <ErrorState title="Could not load finances" error={entries.error} onRetry={() => void entries.refetch()} />
        ) : entries.isPending ? (
          <LoadingState label="Loading finances…" />
        ) : rows.length === 0 ? (
          <EmptyState title="No entries yet">
            {can.canManageFinances
              ? 'Add the first income or expense with “Add entry”.'
              : 'The Treasurer records the season’s income and expenses here.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {rows.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                canManage={can.canManageFinances}
                onEdit={() => {
                  setMessage('')
                  setEditing(entry)
                }}
                onDelete={() => {
                  setMessage('')
                  setDeleting(entry)
                }}
              />
            ))}
          </ul>
        )}
      </div>

      <FinanceEntryDialog
        open={editing !== null}
        entry={editing === 'new' ? null : editing}
        categories={categories}
        onClose={() => setEditing(null)}
        onRefused={setRefusal}
        onSaved={(text) => {
          setEditing(null)
          setMessage(text)
        }}
      />

      <Dialog open={deleting !== null} onClose={closeDelete} labelledBy={deleteTitleId} dismissible={!remove.isPending}>
        {deleting && (
          <div>
            <h2 id={deleteTitleId} className="text-base font-semibold text-balance text-slate-900">
              Delete this entry?
            </h2>
            <p className="mt-2 text-sm text-pretty text-slate-700">
              “{deleting.description}” ({deleting.kind === 'income' ? '+' : '−'}
              {formatEuros(deleting.amount_cents)}, {formatDay(deleting.entry_date)}) will be removed
              for everyone. This cannot be undone.
            </p>
            <ActionError error={remove.error} className="mt-3" />
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" className={buttonSecondary} disabled={remove.isPending} onClick={closeDelete}>
                Cancel
              </button>
              <button
                type="button"
                className={buttonDanger}
                disabled={remove.isPending}
                onClick={() => void confirmDelete(deleting)}
              >
                {remove.isPending ? 'Deleting…' : 'Delete entry'}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </main>
  )
}

function Total({ label, value, tone = 'text-slate-900' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-2.5 sm:p-3">
      <p className="text-xs font-medium tracking-wide text-slate-600 uppercase">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold break-words tabular-nums sm:text-xl ${tone}`}>{value}</p>
    </div>
  )
}

function EntryRow({
  entry,
  canManage,
  onEdit,
  onDelete,
}: {
  entry: FinanceEntry
  canManage: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const income = entry.kind === 'income'
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5" data-testid={`entry-${entry.id}`}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium break-words text-pretty text-slate-900">{entry.description}</p>
        <p className="mt-0.5 text-xs text-slate-600">
          <time dateTime={entry.entry_date}>{formatDay(entry.entry_date)}</time>
          {entry.category && <> · {entry.category}</>}
        </p>
      </div>
      <p className="shrink-0 text-right">
        <span className={`block text-sm font-semibold tabular-nums ${income ? 'text-emerald-700' : 'text-slate-900'}`}>
          {income ? '+' : '−'}
          {formatEuros(entry.amount_cents)}
        </span>
        <span className="block text-xs text-slate-600">{income ? 'Income' : 'Expense'}</span>
      </p>
      {canManage && (
        <div className="flex w-full justify-end gap-2 sm:w-auto">
          <button type="button" className={buttonSecondary} aria-label={`Edit ${entry.description}`} onClick={onEdit}>
            Edit
          </button>
          <button type="button" className={buttonSecondary} aria-label={`Delete ${entry.description}`} onClick={onDelete}>
            Delete
          </button>
        </div>
      )}
    </li>
  )
}
