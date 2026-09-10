// The button styles for the whole app, so equivalent actions look the same on
// every screen. Primary is the one thing you most likely came to do; secondary
// is everything else; quiet is for "skip"/"not now" escape hatches.
// Same height, radius and focus ring — only the fill differs.
const base =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 disabled:opacity-50 sm:min-h-0'

export const buttonPrimary = `${base} bg-slate-900 text-white hover:bg-slate-800`
export const buttonSecondary = `${base} border border-slate-300 bg-white text-slate-800 hover:border-slate-400 hover:bg-slate-50`
export const buttonQuiet = `${base} text-slate-700 underline underline-offset-2 hover:text-slate-900`
