import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/context.ts'
import { ROLE_LABELS, sortRoles } from '../auth/permissions.ts'
import { usePermissions } from '../auth/usePermissions.ts'
import { useCurrentSeason } from '../data/useCurrentSeason.ts'
import { useTutorial } from '../tutorial/context.ts'
import { buttonSecondary } from './buttons.ts'
import { NAV_ITEMS } from './navItems.ts'

// Active screen: filled pill AND aria-current="page" — never colour alone.
const desktopLink = ({ isActive }: { isActive: boolean }) =>
  `inline-flex items-center rounded px-2.5 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 ${
    isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
  }`

const phoneLink = ({ isActive }: { isActive: boolean }) =>
  `flex min-h-11 items-center rounded px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 ${
    isActive ? 'bg-slate-900 text-white' : 'text-slate-800 hover:bg-slate-100'
  }`

// The one navigation for the whole app. Before this, each screen hand-rolled
// its own subset of links: Settings had no way in at all, the Register had no
// way out, and signing out was only possible from a leftover test page.
export function AppHeader() {
  const auth = useAuth()
  const can = usePermissions()
  const tutorial = useTutorial()
  const season = useCurrentSeason()
  const location = useLocation()
  // Remember which page the phone menu was opened on. Any navigation changes
  // the path, which closes it — no effect needed to keep the two in sync.
  const [menuOpenOn, setMenuOpenOn] = useState<string | null>(null)
  const menuOpen = menuOpenOn === location.pathname
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onPointer = (event: PointerEvent) => {
      const node = event.target as Node
      if (panelRef.current?.contains(node) || menuButtonRef.current?.contains(node)) return
      setMenuOpenOn(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuOpenOn(null)
      menuButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const name = auth.status === 'member' ? auth.member.full_name : ''
  // Your roles beside your name, in words, so it is always clear what the
  // screens will let you do.
  const roleText = sortRoles(can.roles).map((role) => ROLE_LABELS[role]).join(', ')
  // Screens that would show this person nothing are left out of the menu.
  const items = NAV_ITEMS.filter((item) => !item.requires || can[item.requires])
  const signOut = () => void auth.signOut()
  const startTour = () => {
    setMenuOpenOn(null)
    tutorial.start()
  }

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-3 py-2 sm:px-6">
        <Link
          to="/"
          className="rounded text-base font-semibold tracking-tight text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
        >
          Paddock Control
        </Link>
        {season.data?.label && (
          <span
            className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-xs font-medium text-slate-700"
            title="Everything on screen belongs to this season"
          >
            <span className="sr-only">Current season: </span>
            {season.data.label}
          </span>
        )}

        <div className="ml-auto hidden items-center gap-2 sm:flex">
          {name && (
            <span className="text-xs text-slate-600">
              {name}
              {roleText && <span className="text-slate-500"> · {roleText}</span>}
            </span>
          )}
          <button type="button" onClick={startTour} className={buttonSecondary} data-tutorial="help-button">
            Tutorial
          </button>
          <button type="button" onClick={signOut} className={buttonSecondary}>
            Sign out
          </button>
        </div>

        {/* On a phone everything collapses behind this one button, so it is
            also what the tutorial points at for "navigation" and "restart". */}
        <button
          ref={menuButtonRef}
          type="button"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? 'phone-menu' : undefined}
          onClick={() => setMenuOpenOn(menuOpen ? null : location.pathname)}
          className={`ml-auto sm:hidden ${buttonSecondary}`}
          data-tutorial="main-nav help-button"
        >
          {menuOpen ? 'Close' : 'Menu'}
        </button>
      </div>

      <nav aria-label="Main" className="mx-auto hidden max-w-6xl px-3 pb-2 sm:block sm:px-6" data-tutorial="main-nav">
        <ul className="flex flex-wrap gap-1">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} end={item.end} className={desktopLink}>
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {menuOpen && (
        <div id="phone-menu" ref={panelRef} className="pc-fade-in border-t border-slate-200 px-3 pb-3 sm:hidden">
          <nav aria-label="Main">
            <ul className="grid grid-cols-2 gap-1 pt-2">
              {items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={phoneLink}
                    // Choosing the page you are already on changes nothing, so
                    // close explicitly rather than rely on the path changing.
                    onClick={() => setMenuOpenOn(null)}
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-2">
            {name && (
              <span className="text-xs text-slate-600">
                Signed in as {name}
                {roleText && ` · ${roleText}`}
              </span>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={startTour} className={buttonSecondary}>
                Tutorial
              </button>
              <button type="button" onClick={signOut} className={buttonSecondary}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  )
}
