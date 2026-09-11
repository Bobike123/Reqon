import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { usePermissions } from '../auth/usePermissions.ts'
import { TutorialContext, type TutorialContextValue } from './context.ts'
import { TUTORIAL_STEPS, type TutorialStep } from './steps.ts'
import { readTutorialRecord, writeTutorialRecord, type TutorialRecord } from './storage.ts'
import { buildTour, tourMenu, type TourSelection } from './tour.ts'
import { TutorialChooser } from './TutorialChooser.tsx'
import { TutorialOffer } from './TutorialOffer.tsx'
import { TutorialOverlay } from './TutorialOverlay.tsx'

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null
}

// Owns the tour: which tour is running and which step is showing, moving
// between screens, the chooser, and whether this browser has seen it before.
// The overlay does the drawing.
export function TutorialProvider({
  children,
  steps = TUTORIAL_STEPS,
  searchTimeoutMs = 4000,
}: {
  children: ReactNode
  steps?: TutorialStep[]
  searchTimeoutMs?: number
}) {
  const can = usePermissions()
  // The running tour, fixed when it starts. Roles refresh in the background; a
  // tour that re-filtered itself half-way through could skip or repeat steps.
  const [tour, setTour] = useState<TutorialStep[] | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [chooserOpen, setChooserOpen] = useState(false)
  const [record, setRecord] = useState<TutorialRecord | null>(() => readTutorialRecord())
  const navigate = useNavigate()
  const location = useLocation()
  // Where focus goes back to when the tour ends. State, not a ref: the value
  // is only read in the end handler, but it travels through the context value.
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null)

  const show = useCallback(
    (running: TutorialStep[], index: number) => {
      const step = running[index]
      if (!step) return
      setTour(running)
      setStepIndex(index)
      // Opening the step's screen is part of moving to the step, so it happens
      // here in the click handler — never in an effect that could fight a user
      // who presses the browser's Back button.
      if (step.route && step.route !== location.pathname) navigate(step.route)
    },
    [location.pathname, navigate],
  )

  const end = useCallback(
    (outcome: TutorialRecord) => {
      setTour(null)
      writeTutorialRecord(outcome)
      setRecord(outcome)
      requestAnimationFrame(() => {
        if (returnFocusTo?.isConnected) returnFocusTo.focus()
        else document.getElementById('main-content')?.focus()
      })
    },
    [returnFocusTo],
  )

  const openChooser = useCallback(() => {
    setReturnFocusTo(focusedElement())
    setChooserOpen(true)
  }, [])
  const closeChooser = useCallback(() => setChooserOpen(false), [])

  const start = useCallback(
    (selection: TourSelection = { kind: 'full' }) => {
      const chosen = buildTour(steps, can, selection)
      if (chosen.length === 0) return
      // Started from the chooser, focus later goes back to whatever opened the
      // chooser — not to the chooser's own button, which is about to go.
      if (!chooserOpen) setReturnFocusTo(focusedElement())
      setChooserOpen(false)
      show(chosen, 0)
    },
    [steps, can, chooserOpen, show],
  )

  const next = useCallback(() => {
    if (!tour) return
    if (stepIndex >= tour.length - 1) end('completed')
    else show(tour, stepIndex + 1)
  }, [tour, stepIndex, end, show])

  const back = useCallback(() => {
    if (tour && stepIndex > 0) show(tour, stepIndex - 1)
  }, [tour, stepIndex, show])

  const skip = useCallback(() => end('dismissed'), [end])
  const finish = useCallback(() => end('completed'), [end])
  const dismissOffer = useCallback(() => {
    writeTutorialRecord('dismissed')
    setRecord('dismissed')
  }, [])

  const step = tour?.[stepIndex] ?? null
  const menu = useMemo(() => tourMenu(steps, can), [steps, can])

  const value = useMemo<TutorialContextValue>(
    () => ({
      active: step !== null,
      stepIndex,
      total: tour?.length ?? 0,
      step,
      // Offered once, to a browser that has never finished or dismissed it.
      offerVisible: record === null && step === null && !chooserOpen,
      chooserOpen,
      menu,
      openChooser,
      closeChooser,
      start,
      next,
      back,
      skip,
      finish,
      dismissOffer,
    }),
    [step, stepIndex, tour, record, chooserOpen, menu, openChooser, closeChooser, start, next, back, skip, finish, dismissOffer],
  )

  return (
    <TutorialContext.Provider value={value}>
      {children}
      {value.offerVisible && <TutorialOffer />}
      {/* Before the overlay on purpose: when a tour starts from the chooser,
          the chooser hands focus back first and the overlay's card takes it
          last, so a keyboard user lands on the explanation. */}
      <TutorialChooser />
      {step && <TutorialOverlay step={step} searchTimeoutMs={searchTimeoutMs} />}
    </TutorialContext.Provider>
  )
}
