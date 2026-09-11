import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { buttonPrimary, buttonQuiet, buttonSecondary } from '../ui/buttons.ts'
import { useTutorial } from './context.ts'
import { clipToViewport, placeCard, SHEET_BREAKPOINT, type Rect } from './placement.ts'
import { AUDIENCES, type TutorialStep } from './steps.ts'
import { chapterLabel } from './tour.ts'

const PAD = 6
const DIM = 'rgba(15, 23, 42, 0.55)'

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

// First VISIBLE element carrying the id. Several elements may share one — the
// desktop nav and the phone Menu button both say "main-nav" — and only one of
// them is on screen at a time.
function findTarget(id: string): HTMLElement | null {
  const matches = document.querySelectorAll<HTMLElement>(`[data-tutorial~="${id}"]`)
  for (let i = 0; i < matches.length; i += 1) {
    const rect = matches[i].getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return matches[i]
  }
  return null
}

type Lookup = { stepId: string; el: HTMLElement | null }

// Draws one step over the real app: a dimmed page, a spotlight around the real
// control, and a small card explaining it.
//
// The dimmed layer swallows every click and the card holds keyboard focus, so
// nothing underneath can be pressed while the tour is open. The tour explains;
// it never changes data.
export function TutorialOverlay({
  step,
  searchTimeoutMs,
}: {
  step: TutorialStep
  searchTimeoutMs: number
}) {
  const tutorial = useTutorial()
  const { skip } = tutorial
  const [lookup, setLookup] = useState<Lookup | null>(null)
  const blockerRef = useRef<HTMLDivElement>(null)
  const spotlightRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // Tagged with its step, so moving to a new step reads as "searching" by
  // derivation instead of by resetting state inside an effect.
  const current = lookup?.stepId === step.id ? lookup : null
  // 'untargeted' is a step about the app as a whole, with nothing to point at.
  const status: 'untargeted' | 'searching' | 'found' | 'missing' = !step.target
    ? 'untargeted'
    : !current
      ? 'searching'
      : current.el
        ? 'found'
        : 'missing'
  const target = current?.el ?? null

  // 1. Find the real control. Screens load their data after navigating, so
  //    look again for a few seconds before giving up.
  useEffect(() => {
    const id = step.target
    if (!id) return
    let cancelled = false
    let timer = 0
    const startedAt = Date.now()
    const look = () => {
      if (cancelled) return
      const el = findTarget(id)
      if (el) {
        el.scrollIntoView?.({
          block: window.innerWidth < SHEET_BREAKPOINT ? 'start' : 'center',
          inline: 'nearest',
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        })
        setLookup({ stepId: step.id, el })
        return
      }
      if (Date.now() - startedAt >= searchTimeoutMs) {
        // Missing: say so and carry on. Never crash, never stay dimmed with no
        // way forward.
        setLookup({ stepId: step.id, el: null })
        return
      }
      timer = window.setTimeout(look, 100)
    }
    timer = window.setTimeout(look, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [step.id, step.target, searchTimeoutMs])

  // 2. Put the spotlight and card where they belong. Writes styles directly:
  //    this runs on every scroll frame and must not re-render React.
  const reposition = useCallback(() => {
    const card = cardRef.current
    const spot = spotlightRef.current
    const blocker = blockerRef.current
    if (!card || !spot || !blocker) return

    const viewport = { width: window.innerWidth, height: window.innerHeight }
    let rect: Rect | null = null
    if (target?.isConnected) {
      const r = target.getBoundingClientRect()
      rect = clipToViewport(
        { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 },
        viewport,
      )
    }

    if (rect) {
      spot.style.display = 'block'
      spot.style.top = `${rect.top}px`
      spot.style.left = `${rect.left}px`
      spot.style.width = `${rect.width}px`
      spot.style.height = `${rect.height}px`
      blocker.style.background = 'transparent'
    } else {
      spot.style.display = 'none'
      blocker.style.background = DIM
    }

    card.style.width = ''
    const position = placeCard(rect, { width: card.offsetWidth, height: card.offsetHeight }, viewport, step.placement)
    card.dataset.placement = position.placement
    if (position.placement === 'sheet') {
      Object.assign(card.style, { top: 'auto', left: '8px', right: '8px', bottom: '8px', width: 'auto' })
    } else {
      Object.assign(card.style, { top: `${position.top}px`, left: `${position.left}px`, right: 'auto', bottom: 'auto' })
    }
  }, [target, step.placement])

  useLayoutEffect(() => {
    reposition()
  })

  // 3. Stay glued to the control through scrolling, resizing and reflow.
  useEffect(() => {
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(reposition)
    }
    window.addEventListener('scroll', schedule, { passive: true, capture: true })
    window.addEventListener('resize', schedule)
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      if (target) observer.observe(target)
      if (cardRef.current) observer.observe(cardRef.current)
    }
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
    }
  }, [reposition, target])

  // 4. Focus follows the step, so keyboard and screen-reader users land on the
  //    explanation rather than somewhere behind the dimmed layer.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true })
  }, [step.id])

  // 5. Escape always gets out.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      skip()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [skip])

  // Tab cycles through the card's buttons while the tour is open; Escape (above)
  // is the way out, so this is a dialog, not a keyboard trap.
  function keepTabInCard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return
    const buttons = cardRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)')
    if (!buttons || buttons.length === 0) return
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === cardRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const number = tutorial.stepIndex + 1
  const isFirst = tutorial.stepIndex === 0
  const isLast = number === tutorial.total
  const titleId = `tutorial-title-${step.id}`
  const bodyId = `tutorial-body-${step.id}`

  return (
    <>
      <div
        ref={blockerRef}
        aria-hidden="true"
        className="fixed inset-0 z-[60]"
        style={{ background: DIM }}
        data-testid="tutorial-blocker"
      />
      <div
        key={`spot-${step.id}`}
        ref={spotlightRef}
        aria-hidden="true"
        className="pc-fade-in pointer-events-none fixed z-[61] rounded-md"
        style={{ display: 'none', boxShadow: `0 0 0 2px #fff, 0 0 0 9999px ${DIM}` }}
        data-testid="tutorial-spotlight"
      />
      <div
        key={`card-${step.id}`}
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        onKeyDown={keepTabInCard}
        className="pc-pop fixed z-[62] max-h-[calc(100vh-1rem)] w-[24rem] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 shadow-xl outline-none"
        style={{ top: 0, left: 0 }}
        data-testid="tutorial-card"
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold tracking-wide text-slate-600">
            {chapterLabel(step.chapter)}{' '}
            <span aria-hidden="true">
              · {number} / {tutorial.total}
            </span>
            <span className="sr-only">
              Step {number} of {tutorial.total}
            </span>
          </p>
          <div className="h-1 w-20 shrink-0 overflow-hidden rounded bg-slate-200" aria-hidden="true">
            <div className="h-full bg-slate-900" style={{ width: `${(number / tutorial.total) * 100}%` }} />
          </div>
        </div>
        {/* Role steps say so, so nobody wonders why a colleague's tour
            showed them a button they do not have. */}
        {step.audience && (
          <p className="mt-2 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-900">
            Only for: {AUDIENCES[step.audience].label}
          </p>
        )}
        <h2 id={titleId} className="mt-1.5 text-base font-semibold text-slate-900">
          {step.title}
        </h2>
        <p id={bodyId} className="mt-1 text-sm leading-relaxed text-slate-700">
          {step.body}
        </p>
        {status === 'missing' && (
          <p role="status" className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
            This part of the screen isn’t showing right now — it may still be loading, or be
            hidden by a filter. You can carry on.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <button type="button" onClick={tutorial.skip} className={buttonQuiet}>
            Skip tutorial
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={tutorial.back} disabled={isFirst} className={buttonSecondary}>
              Back
            </button>
            <button type="button" onClick={isLast ? tutorial.finish : tutorial.next} className={buttonPrimary}>
              {isLast ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
