// One page width for the whole app, shared by the header and every screen so
// their edges line up. Wide on purpose: on a desktop monitor the Board's six
// lanes, the Meetings grid and the Register's two-column rows use the room
// instead of sitting in a narrow strip down the middle. Phones are unaffected —
// below the cap it is just the side padding.
export const SHELL = 'mx-auto w-full max-w-[112rem] px-3 sm:px-6 lg:px-8'

// How far a screen's content may stretch inside the shell. Each value caps
// every direct child of <main>, so the header, notices and lists share one
// right edge.
//   full    — the screen is laid out for width (Board, Meetings, Now, Register)
//   wide    — lists that stay scannable up to a laptop width
//   reading — mostly forms and sentences (Settings, Finances)
const MEASURE = {
  full: '',
  wide: '*:max-w-7xl',
  reading: '*:max-w-4xl',
} as const

export type Measure = keyof typeof MEASURE

export function pageMain(measure: Measure = 'full'): string {
  return `${SHELL} py-4 ${MEASURE[measure]}`.trim()
}
