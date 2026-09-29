// Changing one thing in the address must never erase another. A filter change
// on the Board keeps ?task=, an opened Book page keeps the Register's search,
// and so on: every screen that writes its state to the URL merges into what is
// already there instead of replacing it.
//
// `null` (or an empty string) removes a key; anything else sets it.
export function mergeSearchParams(
  current: URLSearchParams,
  patch: Readonly<Record<string, string | null | undefined>>,
): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === '') next.delete(key)
    else next.set(key, value)
  }
  return next
}

// A comma-separated set kept in one parameter (?open=MS1-1,MS1-2). Empty and
// duplicate entries are dropped; the length cap keeps a hand-edited address
// from growing without bound.
export function readSetParam(params: URLSearchParams, key: string, max = 100): Set<string> {
  const raw = params.get(key)
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && part.length <= 64)
      .slice(0, max),
  )
}

export function writeSetParam(values: ReadonlySet<string>): string | null {
  return values.size === 0 ? null : [...values].join(',')
}
