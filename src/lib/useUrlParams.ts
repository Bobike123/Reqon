import { useCallback, useLayoutEffect, useRef } from 'react'
import { useSearchParams, type NavigateOptions } from 'react-router-dom'

type Update = URLSearchParams | ((current: URLSearchParams) => URLSearchParams)

// useSearchParams, with a writer that always builds on the LATEST address.
//
// React Router applies a navigation as a transition, so until it commits, a
// render still sees the old params — and so does a functional update made in
// that window. Two writes in quick succession (close the Book reader, then type
// in the search at once) then merged into the old address and brought back what
// the first write had removed: the reader reopened (finding F14-15). The writer
// here remembers the address it last produced and builds the next one on it;
// only a committed navigation (a new params object) replaces that memory.
export function useUrlParams(): [URLSearchParams, (update: Update, options?: NavigateOptions) => void] {
  const [params, setParams] = useSearchParams()
  const latest = useRef(params)
  const set = useRef(setParams)
  useLayoutEffect(() => {
    latest.current = params
  }, [params])
  useLayoutEffect(() => {
    set.current = setParams
  })

  const update = useCallback((next: Update, options?: NavigateOptions) => {
    const value = typeof next === 'function' ? next(new URLSearchParams(latest.current)) : next
    latest.current = value
    set.current(value, options)
  }, [])
  return [params, update]
}
