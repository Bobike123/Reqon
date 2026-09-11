import { createContext, useContext } from 'react'
import type { TutorialStep } from './steps.ts'
import type { TourMenu, TourSelection } from './tour.ts'

export type TutorialContextValue = {
  // A tour is running.
  active: boolean
  stepIndex: number
  total: number
  step: TutorialStep | null
  // The one-time first-visit offer is showing.
  offerVisible: boolean
  // The "which tour?" dialog is open.
  chooserOpen: boolean
  // What the chooser offers this person, with step counts.
  menu: TourMenu
  openChooser: () => void
  closeChooser: () => void
  // With no argument: the full tour for this person's roles.
  start: (selection?: TourSelection) => void
  next: () => void
  back: () => void
  skip: () => void
  finish: () => void
  dismissOffer: () => void
}

export const TutorialContext = createContext<TutorialContextValue | null>(null)

export function useTutorial(): TutorialContextValue {
  const value = useContext(TutorialContext)
  if (!value) throw new Error('useTutorial must be used inside <TutorialProvider>.')
  return value
}
