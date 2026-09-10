import { buttonPrimary, buttonSecondary } from '../ui/buttons.ts'
import { useTutorial } from './context.ts'

// A one-time, easy-to-ignore offer. It never blocks the page; "Not now" is
// remembered so nobody is nagged twice. The tour itself stays one click away
// under Tutorial in the header.
export function TutorialOffer() {
  const tutorial = useTutorial()
  return (
    <aside
      aria-labelledby="tutorial-offer-title"
      className="pc-slide-up fixed inset-x-2 bottom-2 z-40 rounded-lg border border-slate-200 bg-white p-3 shadow-lg sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-80"
      data-testid="tutorial-offer"
    >
      <h2 id="tutorial-offer-title" className="text-sm font-semibold text-slate-900">
        New to Paddock Control?
      </h2>
      <p className="mt-0.5 text-sm text-slate-700">
        A short tour points at each screen of the real app. Nothing it shows you gets changed.
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button type="button" onClick={tutorial.start} className={buttonPrimary}>
          Take the tour
        </button>
        <button type="button" onClick={tutorial.dismissOffer} className={buttonSecondary}>
          Not now
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-600">
        You can start it any time from <strong className="font-semibold">Tutorial</strong> in the top bar.
      </p>
    </aside>
  )
}
