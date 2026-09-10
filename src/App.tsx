import { Route, Routes, useLocation } from 'react-router-dom'
import RequireAuth from './auth/RequireAuth.tsx'
import Board from './pages/Board.tsx'
import Diagnostics from './pages/Diagnostics.tsx'
import Home from './pages/Home.tsx'
import Meetings from './pages/Meetings.tsx'
import Milestones from './pages/Milestones.tsx'
import Now from './pages/Now.tsx'
import Priorities from './pages/Priorities.tsx'
import Register from './pages/Register.tsx'
import Settings from './pages/Settings.tsx'
import SpecSheet from './pages/SpecSheet.tsx'
import { TutorialProvider } from './tutorial/TutorialProvider.tsx'
import { AppHeader } from './ui/AppHeader.tsx'
import { ErrorBoundary } from './ui/ErrorBoundary.tsx'

// Every route lives inside <RequireAuth>, so there is no URL an unauthenticated
// visitor can type to reach a screen. Signed out, the only thing that renders
// is the login form.
export default function App() {
  const location = useLocation()
  return (
    <RequireAuth>
      <TutorialProvider>
        {/* WCAG 2.4.1. The Register puts ~2,000 controls after the navigation;
            without this a keyboard user tabs through all of them to reach the
            content. Off-screen until focused, then visible. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-slate-900 focus:px-3 focus:py-2 focus:text-sm focus:text-white"
        >
          Skip to main content
        </a>
        <AppHeader />
        {/* Keyed on the path: a screen that crashed recovers simply by navigating
            somewhere else, instead of staying broken until a full reload. */}
        <ErrorBoundary key={location.pathname}>
          <Routes>
            <Route path="/" element={<Now />} />
            <Route path="/priorities" element={<Priorities />} />
            <Route path="/register" element={<Register />} />
            <Route path="/milestones" element={<Milestones />} />
            <Route path="/board" element={<Board />} />
            <Route path="/meetings" element={<Meetings />} />
            <Route path="/specs" element={<SpecSheet />} />
            <Route path="/settings" element={<Settings />} />
            {/* Leftover Phase 1 page, and the Phase 3 measuring stick for the
                1,146-clause gate. Neither is a real screen or in the menu. */}
            <Route path="/hello" element={<Home />} />
            <Route path="/diagnostics" element={<Diagnostics />} />
          </Routes>
        </ErrorBoundary>
      </TutorialProvider>
    </RequireAuth>
  )
}
