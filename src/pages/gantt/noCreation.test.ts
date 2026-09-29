import { describe, expect, it } from 'vitest'

// The Gantt cannot create a task, by any route. This reads the source rather than
// trusting one screen's markup: nothing under the Gantt, nothing in the data layer
// that writes tasks, and no hook, string or command that could add one. Linking an
// EXISTING task is the only work-association command.

// Every non-test source file, as text (Vite's raw import; no Node types needed).
const all = import.meta.glob(['../../**/*.ts', '../../**/*.tsx', '!../../**/*.test.ts', '!../../**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const entries = Object.entries(all)
// Vite writes each key relative to this folder and normalised (./X.tsx for a
// sibling, ../Gantt.tsx for the page), so match on the shape of the path.
const isGanttFile = (file: string) =>
  /^\.\/[^/]+$/.test(file) || /(^|\/)gantt\/[^/]+$/.test(file) || file.endsWith('/Gantt.tsx')
const ganttFiles = entries.filter(([file]) => isGanttFile(file))
const dataFiles = entries.filter(([file]) => /(^|\/)data\/[^/]+$/.test(file))

describe('no task-creation path on the Gantt', () => {
  it('reads the files it means to (the scan is not vacuous)', () => {
    expect(ganttFiles.length).toBeGreaterThan(10)
    expect(dataFiles.length).toBeGreaterThan(20)
    expect(ganttFiles.some(([file]) => file.endsWith('/Gantt.tsx'))).toBe(true)
    expect(ganttFiles.some(([file]) => file.endsWith('/LinkTaskTool.tsx'))).toBe(true)
  })

  it('has no "Add to Board" text, create hook, insert call or free-text form in any Gantt file', () => {
    for (const [file, text] of ganttFiles) {
      expect(text, file).not.toMatch(/add to board/i)
      expect(text, file).not.toMatch(/useAddSectionTask|useCreateTask|useAddTask|createTask/)
      expect(text, file).not.toMatch(/\.insert\(/)
      expect(text, file).not.toMatch(/\.upsert\(/)
      expect(text, file).not.toMatch(/<textarea|type="text"|<form/)
    }
  })

  it('has no useAddSectionTask anywhere in the app', () => {
    for (const [file, text] of entries) {
      expect(text, file).not.toMatch(/useAddSectionTask/)
    }
  })

  it('the data layer never inserts or upserts into tasks (promotion is a database command)', () => {
    for (const [file, text] of dataFiles) {
      expect(text, file).not.toMatch(/from\('tasks'\)[\s\S]{0,160}\.(insert|upsert)\(/)
    }
  })
})
