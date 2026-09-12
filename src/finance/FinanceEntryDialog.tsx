import { useId, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { isPermissionError } from '../data/errors.ts'
import {
  useAddFinanceEntry,
  useUpdateFinanceEntry,
  type FinanceEntry,
  type FinanceKind,
} from '../data/useFinances.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { ActionError } from '../ui/states.tsx'
import { todayIso } from '../lib/dates.ts'
import { centsToInput, parseEuros } from './money.ts'

type Add = ReturnType<typeof useAddFinanceEntry>
type Update = ReturnType<typeof useUpdateFinanceEntry>
type Field = 'date' | 'description' | 'amount'

// 16px on a phone, so iOS does not zoom the page when a field is tapped.
const input =
  'block min-h-11 w-full rounded border border-slate-300 bg-white px-2.5 text-base text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 aria-invalid:border-red-600 sm:min-h-9 sm:text-sm'
const label = 'block text-sm font-medium text-slate-900'

// Adding or editing one ledger entry. Only the Treasurer is ever shown this;
// what actually stops anyone else is finance_insert / finance_update.
export function FinanceEntryDialog({
  open,
  entry,
  categories,
  onClose,
  onSaved,
  onRefused,
}: {
  open: boolean
  entry: FinanceEntry | null
  categories: readonly string[]
  onClose: () => void
  onSaved: (message: string) => void
  // Told about a permission refusal, which can outlive this dialog.
  onRefused?: (error: Error) => void
}) {
  const titleId = useId()
  const add = useAddFinanceEntry()
  const update = useUpdateFinanceEntry()
  const close = () => {
    add.reset()
    update.reset()
    onClose()
  }
  return (
    <Dialog open={open} onClose={close} labelledBy={titleId} dismissible={!add.isPending && !update.isPending}>
      <EntryForm
        entry={entry}
        categories={categories}
        titleId={titleId}
        add={add}
        update={update}
        onCancel={close}
        onRefused={onRefused}
        onSaved={(message) => {
          add.reset()
          update.reset()
          onSaved(message)
        }}
      />
    </Dialog>
  )
}

function EntryForm({
  entry,
  categories,
  titleId,
  add,
  update,
  onCancel,
  onSaved,
  onRefused,
}: {
  entry: FinanceEntry | null
  categories: readonly string[]
  titleId: string
  add: Add
  update: Update
  onCancel: () => void
  onSaved: (message: string) => void
  onRefused?: (error: Error) => void
}) {
  const ids = useId()
  const [kind, setKind] = useState<FinanceKind>(entry?.kind ?? 'expense')
  const [date, setDate] = useState(entry?.entry_date ?? todayIso())
  const [description, setDescription] = useState(entry?.description ?? '')
  const [amount, setAmount] = useState(entry ? centsToInput(entry.amount_cents) : '')
  const [category, setCategory] = useState(entry?.category ?? '')
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const busy = add.isPending || update.isPending
  const error = add.error ?? update.error

  const idOf = (field: Field) => `${ids}-${field}`
  const invalid = (field: Field) =>
    errors[field] ? { 'aria-invalid': true, 'aria-describedby': `${idOf(field)}-error` } : {}

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const cents = parseEuros(amount)
    const found: Partial<Record<Field, string>> = {}
    if (!date) found.date = 'Pick the day the money moved.'
    if (!description.trim()) found.description = 'Say what it was for.'
    if (cents === null) found.amount = 'Enter an amount above zero, such as 45 or 45.50, without thousands separators.'
    // Commit the error text and aria-invalid before focus moves, so a screen
    // reader announces the field together with what is wrong with it.
    flushSync(() => setErrors(found))
    const first = (['date', 'description', 'amount'] as const).find((field) => found[field])
    if (first || cents === null) {
      document.getElementById(idOf(first ?? 'amount'))?.focus()
      return
    }
    const draft = {
      entryDate: date,
      kind,
      description: description.trim(),
      category: category.trim() || null,
      amountCents: cents,
    }
    try {
      if (entry) await update.mutateAsync({ id: entry.id, ...draft })
      else await add.mutateAsync(draft)
      onSaved(entry ? 'Entry updated.' : 'Entry added.')
    } catch (err) {
      // The refusal is shown below the form, and everything typed stays put.
      // A permission refusal is also passed up: if this person has just lost
      // access, the whole screen changes and this form goes with it.
      if (err instanceof Error && isPermissionError(err)) onRefused?.(err)
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <h2 id={titleId} className="text-base font-semibold text-balance text-slate-900">
        {entry ? 'Edit entry' : 'Add an entry'}
      </h2>

      <fieldset className="mt-4" disabled={busy}>
        <legend className={label}>Type</legend>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {(['expense', 'income'] as const).map((value) => (
            <label
              key={value}
              className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-800 has-checked:border-slate-900 has-checked:bg-slate-900 has-checked:text-white has-focus-visible:ring-2 has-focus-visible:ring-slate-500 has-focus-visible:ring-offset-2"
            >
              <input
                type="radio"
                name={`${ids}-kind`}
                value={value}
                checked={kind === value}
                onChange={() => setKind(value)}
                className="sr-only"
              />
              {value === 'income' ? 'Income' : 'Expense'}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-3 grid gap-3 sm:grid-cols-2" disabled={busy}>
        <div>
          <label htmlFor={idOf('date')} className={label}>Date</label>
          <input
            id={idOf('date')}
            name="entry_date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={`mt-1 ${input}`}
            {...invalid('date')}
          />
          {errors.date && <p id={`${idOf('date')}-error`} className="mt-1 text-sm text-red-700">{errors.date}</p>}
        </div>
        <div>
          <label htmlFor={idOf('amount')} className={label}>Amount (€)</label>
          <div className="relative mt-1">
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-slate-500">
              €
            </span>
            <input
              id={idOf('amount')}
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="45.50"
              className={`${input} pl-6 tabular-nums`}
              {...invalid('amount')}
            />
          </div>
          {errors.amount && <p id={`${idOf('amount')}-error`} className="mt-1 text-sm text-red-700">{errors.amount}</p>}
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={idOf('description')} className={label}>Description</label>
          <input
            id={idOf('description')}
            name="description"
            value={description}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Entry fee, brake pads, sponsor payment…"
            className={`mt-1 ${input}`}
            {...invalid('description')}
          />
          {errors.description && (
            <p id={`${idOf('description')}-error`} className="mt-1 text-sm text-red-700">{errors.description}</p>
          )}
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${ids}-category`} className={label}>
            Category <span className="font-normal text-slate-600">(optional)</span>
          </label>
          <input
            id={`${ids}-category`}
            name="category"
            list={`${ids}-categories`}
            value={category}
            maxLength={60}
            autoComplete="off"
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Parts, Travel, Sponsorship…"
            className={`mt-1 ${input}`}
          />
          <datalist id={`${ids}-categories`}>
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
      </fieldset>

      <ActionError error={error} className="mt-3" />

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={onCancel} disabled={busy} className={buttonSecondary}>
          Cancel
        </button>
        <button type="submit" disabled={busy} className={buttonPrimary}>
          {busy ? 'Saving…' : entry ? 'Save changes' : 'Add entry'}
        </button>
      </div>
    </form>
  )
}
