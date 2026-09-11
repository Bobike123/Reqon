// Whether this browser has already seen the tour. Kept in localStorage on
// purpose: it is a per-device convenience, not club data, and does not belong
// in the database. Every access is wrapped — private windows and locked-down
// browsers throw on localStorage, and a tour must never break the app.
//
// v2: the tour grew from a 12-step overview into one that covers every screen
// in depth, with extra parts for each role. The new key offers it once more to
// people who finished or dismissed the old one.
const KEY = 'reqon.tutorial.v2'

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
