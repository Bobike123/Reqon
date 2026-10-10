import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

// Where each history entry was scrolled to, by React Router's location key.
const positions = new Map<string, number>()

// A new screen starts at its top; Back and Forward return to where you were.
// Without it, a link followed from deep in a long list (the Register, on a
// phone) opened the next screen just as far down, and Back lost the place in
// the list: the browser's own restoration runs before the screen's code and
// data have arrived, while the page is still too short to scroll that far.
export function useScrollRestoration() {
  const { key, pathname } = useLocation()
  const navigationType = useNavigationType()
  const lastPath = useRef(pathname)
  // The entry being looked at now. Set before a new screen scrolls to its top,
  // so that scroll is never recorded against the entry just left.
  const current = useRef(key)

  useEffect(() => {
    window.history.scrollRestoration = 'manual'
    const save = () => positions.set(current.current, window.scrollY)
    window.addEventListener('scroll', save, { passive: true })
    return () => window.removeEventListener('scroll', save)
  }, [])

  useLayoutEffect(() => {
    current.current = key
    const samePage = lastPath.current === pathname
    lastPath.current = pathname
    if (navigationType !== 'POP') {
      // Same screen (a filter, the Register's reader): stay put.
      if (samePage) positions.set(key, window.scrollY)
      else window.scrollTo(0, 0)
      return
    }
    const y = positions.get(key)
    if (y === undefined) return
    // The screen may still be loading: keep trying until it is tall enough,
    // for up to a second.
    const started = performance.now()
    let frame = 0
    const restore = () => {
      window.scrollTo(0, y)
      if (Math.abs(window.scrollY - y) > 1 && performance.now() - started < 1000) frame = requestAnimationFrame(restore)
    }
    restore()
    return () => cancelAnimationFrame(frame)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}
