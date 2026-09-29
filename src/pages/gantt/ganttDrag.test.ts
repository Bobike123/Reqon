import { describe, expect, it, vi } from 'vitest'
import { TASK_DRAG_TYPE, taskDropHandlers } from './ganttDrag.ts'

// A drag event as the browser delivers it: only the types are readable while
// dragging over; the data on drop.
function dragEvent(types: string[], data: Record<string, string> = {}) {
  return {
    preventDefault: vi.fn(),
    dataTransfer: { types, dropEffect: 'none', getData: (t: string) => data[t] ?? '' },
  } as unknown as Parameters<ReturnType<typeof taskDropHandlers>['onDrop']>[0]
}

describe('taskDropHandlers', () => {
  it('accepts only a dragged task: highlights on hover and hands over its id on drop', () => {
    const onTask = vi.fn()
    const setOver = vi.fn()
    const h = taskDropHandlers(onTask, setOver)
    const over = dragEvent([TASK_DRAG_TYPE])
    h.onDragOver(over)
    expect(over.preventDefault).toHaveBeenCalled()
    expect(over.dataTransfer.dropEffect).toBe('move')
    expect(setOver).toHaveBeenLastCalledWith(true)
    h.onDrop(dragEvent([TASK_DRAG_TYPE], { [TASK_DRAG_TYPE]: 't1' }))
    expect(onTask).toHaveBeenCalledWith('t1')
    expect(setOver).toHaveBeenLastCalledWith(false)
  })

  it('ignores anything else dropped on a section (text, a file) and clears the highlight on leave', () => {
    const onTask = vi.fn()
    const setOver = vi.fn()
    const h = taskDropHandlers(onTask, setOver)
    const text = dragEvent(['text/plain'])
    h.onDragOver(text)
    expect(text.preventDefault).not.toHaveBeenCalled()
    expect(setOver).not.toHaveBeenCalled()
    h.onDrop(dragEvent(['text/plain'], { 'text/plain': 'hello' }))
    expect(onTask).not.toHaveBeenCalled()
    h.onDragLeave()
    expect(setOver).toHaveBeenLastCalledWith(false)
  })
})
