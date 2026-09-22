import { useEffect, useRef, useState } from 'react'
import { DEFAULT_JOB_TITLE } from './rosterModel.ts'

// Picking a job title, not typing one. members.role is free text in the
// database, and free text drifts: "Chassis", "chassis" and "Chasis" all end up
// on the roster and none of them group. The list is built from the titles the
// club already uses, so the common case is one click — and a title that does
// not exist yet is still one field away.
const NEW_TITLE = '__new__'

const control =
  'min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-60 sm:min-h-0'

export function JobTitleSelect({
  id,
  label,
  titles,
  value,
  disabled,
  onChange,
}: {
  id: string
  // What a screen reader announces. Shown visibly by the caller, or not at all.
  label: string
  titles: readonly string[]
  value: string
  disabled?: boolean
  onChange: (title: string) => void
}) {
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (typing) input.current?.focus()
  }, [typing])

  function save() {
    const title = draft.trim()
    // An empty new title would read as "no job title", which the column does
    // not allow; fall back to what the schema would have used.
    onChange(title || DEFAULT_JOB_TITLE)
    setTyping(false)
    setDraft('')
  }

  if (typing) {
    return (
      <span className="flex flex-wrap items-center gap-1">
        <label className="sr-only" htmlFor={`${id}-new`}>
          New job title for this person
        </label>
        <input
          id={`${id}-new`}
          ref={input}
          value={draft}
          disabled={disabled}
          placeholder="e.g. Aerodynamics"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Inside a form (the add-member form), Enter must add the title,
            // not submit the form behind it.
            if (e.key === 'Enter') {
              e.preventDefault()
              save()
            }
            if (e.key === 'Escape') {
              setTyping(false)
              setDraft('')
            }
          }}
          className={`${control} w-40`}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={save}
          className="min-h-11 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 hover:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
        >
          Use it
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setTyping(false)
            setDraft('')
          }}
          className="min-h-11 rounded px-2 py-1 text-xs text-slate-600 underline underline-offset-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
        >
          Cancel
        </button>
      </span>
    )
  }

  // A select whose value is not among its options shows the FIRST option
  // instead, which would quietly misreport someone's job title — and the list
  // folds "chassis" into "Chassis", so a value can be missing by one letter's
  // case. Whatever is saved is always shown, exactly as saved.
  const options = value.trim() && !titles.includes(value) ? [value, ...titles] : titles

  return (
    <>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === NEW_TITLE) {
            setDraft('')
            setTyping(true)
            return
          }
          onChange(e.target.value)
        }}
        className={control}
      >
        {options.map((title) => (
          <option key={title} value={title}>
            {title}
          </option>
        ))}
        <option value={NEW_TITLE}>Add a new job title…</option>
      </select>
    </>
  )
}
