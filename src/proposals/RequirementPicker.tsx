import { useId, useMemo, useState } from 'react'
import { searchRequirements, type RequirementOption } from './requirementOptions.ts'

const FIELD =
  'mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0'

// A searchable multi-select built from native controls: a search box, a list of
// checkboxes for the matches, and a removable chip for everything chosen. Native
// checkboxes give keyboard selection (Tab, Space) and screen-reader state for
// free. Identity is the clause_key; the printed reference is only what is shown.
export function RequirementPicker({
  id,
  options,
  selected,
  onChange,
  describedBy,
  invalid = false,
  disabled = false,
}: {
  id: string
  options: readonly RequirementOption[]
  selected: readonly string[]
  onChange: (keys: string[]) => void
  describedBy?: string
  invalid?: boolean
  disabled?: boolean
}) {
  const [text, setText] = useState('')
  const listId = useId()
  const matches = useMemo(() => searchRequirements(options, text), [options, text])
  const chosen = new Set(selected)
  const byKey = useMemo(() => new Map(options.map((o) => [o.key, o])), [options])

  const toggle = (key: string) =>
    onChange(chosen.has(key) ? selected.filter((k) => k !== key) : [...selected, key])

  return (
    <div>
      <label htmlFor={`${id}-search`} className="block text-xs font-medium text-slate-600">
        Find a requirement
      </label>
      <input
        id={`${id}-search`}
        type="search"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type a reference, a key or a word from the rule"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-controls={listId}
        className={FIELD}
      />

      <ul aria-label="Chosen requirements" className="mt-2 flex flex-wrap gap-1.5" data-testid="chosen-requirements">
        {selected.length === 0 && <li className="text-xs text-slate-500">None chosen yet.</li>}
        {selected.map((key) => {
          const option = byKey.get(key)
          return (
            <li key={key} className="inline-flex items-center gap-1 rounded bg-slate-100 py-0.5 pr-1 pl-2 text-xs text-slate-800">
              <span>{option?.duplicate ? `${option.ref} (key ${key})` : (option?.ref ?? key)}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => toggle(key)}
                aria-label={`Remove requirement ${option?.ref ?? key}${option?.duplicate ? ` (key ${key})` : ''}`}
                className="min-h-6 min-w-6 rounded text-slate-600 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>

      <fieldset id={listId} className="mt-2" disabled={disabled}>
        <legend className="sr-only">Matching requirements</legend>
        <p role="status" className="mb-1 text-xs text-slate-500" data-testid="requirement-count">
          {matches.length === 0
            ? 'No requirement matches that search.'
            : `${matches.length} shown${matches.length >= 30 ? ' — type more to narrow them' : ''}.`}
        </p>
        <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded border border-slate-200 p-1">
          {matches.map((o) => (
            <li key={o.key}>
              <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50 sm:min-h-0">
                <input
                  type="checkbox"
                  checked={chosen.has(o.key)}
                  onChange={() => toggle(o.key)}
                  className="mt-0.5 size-4"
                />
                <span>{o.label}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </div>
  )
}
