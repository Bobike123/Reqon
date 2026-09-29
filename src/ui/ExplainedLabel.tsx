import { useId, useState } from 'react'
import type { LabelInfo } from '../clauses/labels.ts'

// A small label whose meaning is one tap, click, Enter or focus away — never
// hover alone. Hover and keyboard focus show the sentence for a moment; a tap,
// click or Enter pins it open until pressed again (or Escape). Assistive
// technology gets the same sentence as the button's description whether or not
// it is showing, so nothing essential lives only in a tooltip.
export function ExplainedLabel({
  info,
  className,
  testId,
}: {
  info: LabelInfo
  className: string
  testId?: string
}) {
  const descriptionId = useId()
  const [pinned, setPinned] = useState(false)
  const [transient, setTransient] = useState(false)
  const open = pinned || transient

  return (
    <span className="relative inline-block">
      <button
        type="button"
        aria-expanded={pinned}
        aria-describedby={descriptionId}
        data-testid={testId}
        onClick={() => setPinned((value) => !value)}
        onMouseEnter={() => setTransient(true)}
        onMouseLeave={() => setTransient(false)}
        onFocus={() => setTransient(true)}
        onBlur={() => {
          setTransient(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setPinned(false)
            setTransient(false)
          }
        }}
        className={`min-h-11 rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0 ${className}`}
      >
        {info.label}
      </button>
      {/* Always present for screen readers; the visible copy below is a repeat. */}
      <span id={descriptionId} className="sr-only">
        {info.summary}
      </span>
      {open && (
        <span
          aria-hidden="true"
          data-testid={testId ? `${testId}-explanation` : undefined}
          className="absolute left-0 top-full z-20 mt-1 block w-64 max-w-[min(16rem,80vw)] rounded border border-slate-300 bg-white p-2 text-xs font-normal normal-case tracking-normal text-slate-800 shadow-md"
        >
          {info.summary}
        </span>
      )}
    </span>
  )
}
