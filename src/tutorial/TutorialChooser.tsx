import { useId } from 'react'
import { buttonSecondary } from '../ui/buttons.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { useTutorial } from './context.ts'

const option =
  'flex min-h-11 w-full flex-col items-start gap-0.5 rounded-lg px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2'
const optionPrimary = `${option} bg-slate-900 text-white hover:bg-slate-800`
const optionSecondary = `${option} border border-slate-300 bg-white text-slate-900 hover:border-slate-400 hover:bg-slate-50`
const chapterButton =
  'flex min-h-11 w-full items-center justify-between gap-3 rounded border border-slate-200 bg-white px-3 py-2 text-left text-sm font-medium text-slate-800 hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500'

const stepCount = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`

// Where the Tutorial button leads: the whole tour, only the parts a role adds,
// or one screen on its own. The full tour covers every control, so nobody
// should have to sit through all of it to learn one screen.
export function TutorialChooser() {
  const tutorial = useTutorial()
  const { menu } = tutorial
  const titleId = useId()

  return (
    <Dialog open={tutorial.chooserOpen} onClose={tutorial.closeChooser} labelledBy={titleId}>
      <h2 id={titleId} className="text-base font-semibold text-balance text-slate-900">
        Guided tour
      </h2>
      <p className="mt-1 text-sm text-pretty text-slate-700">
        It walks through the real screens and points at the real controls. It never clicks
        anything or changes data, and Escape leaves it at any time.
      </p>

      <div className="mt-4 grid gap-2">
        <button type="button" className={optionPrimary} onClick={() => tutorial.start({ kind: 'full' })}>
          <span className="font-semibold">Full tour</span>
          <span className="text-sm text-slate-200">
            {menu.role ? `Every screen, plus the ${menu.role.label} parts` : 'Every screen, in order'} ·{' '}
            {stepCount(menu.full)}
          </span>
        </button>
        {menu.role && (
          <button type="button" className={optionSecondary} onClick={() => tutorial.start({ kind: 'role' })}>
            <span className="font-semibold">Only the {menu.role.label} parts</span>
            <span className="text-sm text-slate-600">
              For when you know the rest · {stepCount(menu.role.count)}
            </span>
          </button>
        )}
      </div>

      <h3 className="mt-5 text-sm font-semibold text-slate-900">One screen at a time</h3>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {menu.chapters.map((chapter) => (
          <li key={chapter.id}>
            <button
              type="button"
              className={chapterButton}
              onClick={() => tutorial.start({ kind: 'chapter', chapter: chapter.id })}
            >
              <span>{chapter.label}</span>
              <span className="shrink-0 text-xs font-normal text-slate-600 tabular-nums">
                {stepCount(chapter.count)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {menu.developerGuide && (
        <section aria-labelledby={`${titleId}-dev`} className="mt-5 border-t border-slate-200 pt-4" data-testid="developer-guide">
          <h3 id={`${titleId}-dev`} className="text-sm font-semibold text-slate-900">
            Developer guide
          </h3>
          <p className="mt-0.5 text-sm text-pretty text-slate-600">
            Separate from the tour: how the backups work, which keys a data transfer needs, and which scripts load a backup. Only
            Developers see it.
          </p>
          <button type="button" className={`${optionSecondary} mt-2`} onClick={() => tutorial.start({ kind: 'guide' })}>
            <span className="font-semibold">Backups, keys and loading a backup</span>
            <span className="text-sm text-slate-600">The whole guide · {stepCount(menu.developerGuide.count)}</span>
          </button>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {menu.developerGuide.parts.map((part) => (
              <li key={part.id}>
                <button type="button" className={chapterButton} onClick={() => tutorial.start({ kind: 'guide', part: part.id })}>
                  <span>{part.label}</span>
                  <span className="shrink-0 text-xs font-normal text-slate-600 tabular-nums">{stepCount(part.count)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-5 flex justify-end">
        <button type="button" className={buttonSecondary} onClick={tutorial.closeChooser}>
          Close
        </button>
      </div>
    </Dialog>
  )
}
