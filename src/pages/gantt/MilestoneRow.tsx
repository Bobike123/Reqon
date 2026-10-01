import { milestoneLabel } from '../../milestones/label.ts'
import type { Milestone, MilestoneSection } from '../../data/useMilestones.ts'
import type { Task } from '../../data/useTasks.ts'
import { formatDay } from '../../lib/dates.ts'
import { sectionsFor, subsectionsOf, topLevelSections } from '../milestones/milestoneModel.ts'
import { Bar, Marker, ROW, STICKY_LABEL, Track } from './GanttChart.tsx'
import { SectionRow } from './SectionRow.tsx'
import { UnsectionedRow } from './UnsectionedRow.tsx'
import type { GanttEnv } from './ganttEnv.ts'
import { milestoneMarks, milestoneSummary } from './ganttMarks.ts'
import { lensProgress, milestoneProgress, progressLabel, type ProgressRow } from './ganttProgress.ts'

// One submission: its window bar and deadline, TWO progress figures when a
// department filter is on (the overall one, which never changes with the filter,
// and the filtered one, labelled with the department), and — when open — its
// sections and its unsectioned work.
export function MilestoneRow({
  milestone,
  sections,
  tasks,
  progressTasks,
  open,
  onToggle,
  openSections,
  onToggleSection,
  onDraftedChange,
  env,
}: {
  milestone: Milestone
  sections: MilestoneSection[]
  // Active tasks: the rows that are listed.
  tasks: Task[]
  // Active AND archived tasks: what progress is counted from.
  progressTasks: ProgressRow[]
  open: boolean
  onToggle: () => void
  openSections: ReadonlySet<string>
  onToggleSection: (key: string) => void
  onDraftedChange: (sectionId: string, isDrafted: boolean) => void
  env: GanttEnv
}) {
  // Every section and subsection of the milestone count toward progress; only the
  // top-level ones are rows here — a subsection is drawn under its parent.
  const mySections = sectionsFor(sections, milestone.key)
  const topSections = topLevelSections(sections, milestone.key)
  const marks = milestoneMarks(milestone, env.today)
  const progress = milestoneProgress(mySections, progressTasks, milestone.key)
  const words = progressLabel(progress)
  const lens = env.lens.active
    ? lensProgress(mySections, progressTasks.filter(env.lens.matches), milestone.key)
    : null
  const late = marks.passed && (progress.percent ?? 0) < 100
  const unsectionedKey = `unsectioned:${milestone.key}`

  const badge =
    progress.basis === 'tasks'
      ? `Overall ${progress.percent}%`
      : progress.basis === 'drafted'
        ? `${progress.done}/${progress.total} drafted`
        : 'No linked work'

  return (
    <li className="border-b border-slate-100 py-1.5 last:border-0" data-testid={`gantt-milestone-${milestone.key}`}>
      <div className={`${ROW} rounded bg-slate-100 py-0.5`}>
        <div className={`${STICKY_LABEL} flex flex-wrap items-center gap-1.5 bg-slate-100 pr-2`}>
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="flex min-h-11 items-center gap-1.5 text-left text-sm font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 sm:min-h-0"
          >
            <span aria-hidden="true" className="w-3 text-slate-500">
              {open ? '▾' : '▸'}
            </span>
            <span className="font-mono text-xs">{milestoneLabel(milestone)}</span>
            <span className="font-normal">{milestone.name}</span>
          </button>
          <span className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1">
            <span
              data-testid={`gantt-overall-${milestone.key}`}
              title={words}
              className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                progress.percent === 100 ? 'bg-green-100 text-green-800' : late ? 'bg-red-100 text-red-800' : 'bg-slate-200 text-slate-700'
              }`}
            >
              {badge}
              {late ? ' · deadline passed' : ''}
            </span>
            {lens && (
              <span
                data-testid={`gantt-lens-${milestone.key}`}
                className="rounded border border-slate-400 bg-white px-1.5 py-0.5 text-xs text-slate-800"
              >
                {lens.basis === 'tasks' ? `${env.lens.name}: ${lens.done} of ${lens.total} done` : `${env.lens.name}: no linked work`}
              </span>
            )}
          </span>
        </div>

        <Track
          today={env.todayLeft}
          label={marks.deadline === null ? (marks.opensOnly ? `Opens ${formatDay(marks.opensOnly)} · deadline TBC` : 'Deadline TBC') : undefined}
          summary={milestoneSummary(milestone, env.today, words)}
        >
          {marks.window && (
            <Bar
              span={marks.window}
              range={env.range}
              percent={progress.percent ?? 0}
              tone={late ? 'bg-red-600' : 'bg-slate-700'}
              title={`${milestoneLabel(milestone)}: ${
                marks.window.from === marks.window.to ? '' : `${formatDay(marks.window.from)} → `
              }${formatDay(marks.window.to)} · ${words}`}
            />
          )}
          {marks.deadline && (
            <Marker
              day={marks.deadline}
              range={env.range}
              kind="milestone-deadline"
              overdue={late}
              title={`${milestoneLabel(milestone)} deadline: ${formatDay(marks.deadline)}${marks.passed ? ' (passed)' : ''}${
                marks.window ? '' : ' — no opening date published'
              }`}
            />
          )}
        </Track>
      </div>

      {open && mySections.length === 0 && (
        <p className="sticky left-0 z-10 w-fit bg-white py-1 pl-6 text-xs text-slate-600">
          No sections listed for this submission yet.
        </p>
      )}

      {open &&
        topSections.map((section) => (
          <SectionRow
            key={section.id}
            section={section}
            milestoneKey={milestone.key}
            tasks={tasks}
            progressTasks={progressTasks}
            fallbackSpan={marks.window ?? (marks.deadline ? { from: marks.deadline, to: marks.deadline } : null)}
            open={openSections.has(section.id)}
            onToggle={() => onToggleSection(section.id)}
            onDraftedChange={(isDrafted) => onDraftedChange(section.id, isDrafted)}
            subsections={subsectionsOf(sections, section.id)}
            openSections={openSections}
            onToggleSection={onToggleSection}
            onDraftedChangeById={onDraftedChange}
            env={env}
          />
        ))}

      {open && (
        <UnsectionedRow
          milestone={milestone}
          tasks={tasks}
          progressTasks={progressTasks}
          open={openSections.has(unsectionedKey)}
          onToggle={() => onToggleSection(unsectionedKey)}
          env={env}
        />
      )}
    </li>
  )
}
