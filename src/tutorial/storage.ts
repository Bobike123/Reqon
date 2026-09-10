// Whether this browser has already seen the tour. Kept in localStorage on
// purpose: it is a per-device convenience, not club data, and does not belong
// in the database. Every access is wrapped — private windows and locked-down
// browsers throw on localStorage, and a tour must never break the app.
const KEY = 'paddock-control.tutorial.v1'

export type TutorialRecord = 'completed' | 'dismissed'

export function readTutorialRecord(): TutorialRecord | null {
  try {
    const value = window.localStorage.getItem(KEY)
    return value === 'completed' || value === 'dismissed' ? value : null
  } catch {
    return null
  }
}

export function writeTutorialRecord(value: TutorialRecord): void {
  try {
    window.localStorage.setItem(KEY, value)
  } catch {
    // Nothing to do: the worst case is being offered the tour again.
  }
}
