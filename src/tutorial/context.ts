import { createContext, useContext } from 'react'
import type { TutorialStep } from './steps.ts'

export type TutorialContextValue = {
  active: boolean
  stepIndex: number
  total: number
  step: TutorialStep | null
  offerVisible: boolean
  start: () => void
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
