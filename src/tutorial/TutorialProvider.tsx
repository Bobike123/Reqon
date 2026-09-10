import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { TutorialContext, type TutorialContextValue } from './context.ts'
import { TUTORIAL_STEPS, type TutorialStep } from './steps.ts'
import { readTutorialRecord, writeTutorialRecord, type TutorialRecord } from './storage.ts'
import { TutorialOffer } from './TutorialOffer.tsx'
import { TutorialOverlay } from './TutorialOverlay.tsx'

// Owns the tour: which step is showing, moving between screens, and whether
// this browser has seen it before. The overlay does the drawing.
export function TutorialProvider({
  children,
  steps = TUTORIAL_STEPS,
  searchTimeoutMs = 4000,
}: {
  children: ReactNode
  steps?: TutorialStep[]
  searchTimeoutMs?: number
}) {
  const [stepIndex, setStepIndex] = useState<number | null>(null)
  const [record, setRecord] = useState<TutorialRecord | null>(() => readTutorialRecord())
  const navigate = useNavigate()
  const location = useLocation()
  // Where focus goes back to when the tour ends. State, not a ref: the value
  // is only read in the end handler, but it travels through the context value.
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null)

  const goTo = useCallback(
    (index: number) => {
      const step = steps[index]
      if (!step) return
      setStepIndex(index)
      // Opening the step's screen is part of moving to the step, so it happens
      // here in the click handler — never in an effect that could fight a user
      // who presses the browser's Back button.
      if (step.route && step.route !== location.pathname) navigate(step.route)
    },
    [steps, location.pathname, navigate],
  )

  const end = useCallback(
    (outcome: TutorialRecord) => {
      setStepIndex(null)
      writeTutorialRecord(outcome)
      setRecord(outcome)
      requestAnimationFrame(() => {
        if (returnFocusTo?.isConnected) returnFocusTo.focus()
        else document.getElementById('main-content')?.focus()
      })
    },
    [returnFocusTo],
  )

  const start = useCallback(() => {
    setReturnFocusTo(document.activeElement instanceof HTMLElement ? document.activeElement : null)
    goTo(0)
  }, [goTo])

  const next = useCallback(() => {
    if (stepIndex === null) return
    if (stepIndex >= steps.length - 1) end('completed')
    else goTo(stepIndex + 1)
  }, [stepIndex, steps.length, end, goTo])

  const back = useCallback(() => {
    if (stepIndex !== null && stepIndex > 0) goTo(stepIndex - 1)
  }, [stepIndex, goTo])

  const skip = useCallback(() => end('dismissed'), [end])
  const finish = useCallback(() => end('completed'), [end])
  const dismissOffer = useCallback(() => {
    writeTutorialRecord('dismissed')
    setRecord('dismissed')
  }, [])

  const step = stepIndex === null ? null : (steps[stepIndex] ?? null)

  const value = useMemo<TutorialContextValue>(
    () => ({
      active: step !== null,
      stepIndex: stepIndex ?? 0,
      total: steps.length,
      step,
      // Offered once, to a browser that has never finished or dismissed it.
      offerVisible: record === null && step === null,
      start,
      next,
      back,
      skip,
      finish,
      dismissOffer,
    }),
    [step, stepIndex, steps.length, record, start, next, back, skip, finish, dismissOffer],
  )

  return (
    <TutorialContext.Provider value={value}>
      {children}
      {value.offerVisible && <TutorialOffer />}
      {step && <TutorialOverlay step={step} searchTimeoutMs={searchTimeoutMs} />}
    </TutorialContext.Provider>
  )
}
