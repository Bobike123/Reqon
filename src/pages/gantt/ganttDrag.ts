import type { DragEvent } from 'react'

// Dragging a Gantt task row onto a section: the drag carries only the task id,
// under a type of its own, so nothing else dropped on a section is mistaken for
// a task.
export const TASK_DRAG_TYPE = 'application/x-reqon-task'

// Drop-target handlers for a section or an unsectioned group: they accept only a
// dragged task (TASK_DRAG_TYPE), highlight while one is over them, and hand the
// task id to the screen, which decides and confirms the move.
export function taskDropHandlers(onTaskId: (taskId: string) => void, setOver: (over: boolean) => void) {
  const accepts = (types: readonly string[]) => types.includes(TASK_DRAG_TYPE)
  return {
    onDragOver: (event: DragEvent) => {
      if (!accepts(event.dataTransfer.types)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (event: DragEvent) => {
      setOver(false)
      const id = event.dataTransfer.getData(TASK_DRAG_TYPE)
      if (!id) return
      event.preventDefault()
      onTaskId(id)
    },
  }
}
