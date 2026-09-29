import { fireEvent, render } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ScheduleHandles } from './ScheduleHandles.tsx'

// October 2026 on a 310 px track: one day is 10 px.
const RANGE = { from: '2026-10-01', to: '2026-10-31' }

beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {}
})

function renderHandles(dates: { start: string | null; due: string | null }) {
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  const view = render(
    <div data-testid="track">
      <ScheduleHandles dates={dates} range={RANGE} title="Weld" onPreview={onPreview} onCommit={onCommit} />
    </div>,
  )
  const track = view.container.firstElementChild as HTMLElement
  track.getBoundingClientRect = () => ({ width: 310, left: 0, right: 310, top: 0, bottom: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) })
  const part = (name: string) => view.container.querySelector(`[data-schedule-part="${name}"]`) as HTMLElement
  const drag = (el: HTMLElement, dx: number) => {
    fireEvent.pointerDown(el, { button: 0, clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(el, { clientX: 100 + dx, pointerId: 1 })
    fireEvent.pointerUp(el, { clientX: 100 + dx, pointerId: 1 })
  }
  return { onPreview, onCommit, part, drag }
}

describe('ScheduleHandles', () => {
  it('moves both dates of a period by whole days, committing once on release', () => {
    const { part, drag, onCommit, onPreview } = renderHandles({ start: '2026-10-05', due: '2026-10-10' })
    drag(part('move'), 30)
    expect(onPreview).toHaveBeenCalledWith({ start: '2026-10-08', due: '2026-10-13' })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith({ start: '2026-10-08', due: '2026-10-13' })
  })

  it('changes one end alone, and never lets the start pass the deadline', () => {
    const start = renderHandles({ start: '2026-10-05', due: '2026-10-10' })
    start.drag(start.part('start'), 100)
    expect(start.onCommit).toHaveBeenCalledWith({ start: '2026-10-10', due: '2026-10-10' })
    const end = renderHandles({ start: '2026-10-05', due: '2026-10-10' })
    end.drag(end.part('end'), -20)
    expect(end.onCommit).toHaveBeenCalledWith({ start: '2026-10-05', due: '2026-10-08' })
  })

  it('moves a deadline-only marker, and a tiny wobble commits nothing', () => {
    const marker = renderHandles({ start: null, due: '2026-10-20' })
    marker.drag(marker.part('move'), -10)
    expect(marker.onCommit).toHaveBeenCalledWith({ start: null, due: '2026-10-19' })
    const wobble = renderHandles({ start: null, due: '2026-10-20' })
    wobble.drag(wobble.part('move'), 2)
    expect(wobble.onCommit).not.toHaveBeenCalled()
    expect(wobble.onPreview).toHaveBeenLastCalledWith(null)
  })

  it('a cancelled drag (the pointer was taken away) commits nothing and clears the preview', () => {
    const { part, onCommit, onPreview } = renderHandles({ start: '2026-10-05', due: '2026-10-10' })
    const el = part('move')
    fireEvent.pointerDown(el, { button: 0, clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(el, { clientX: 150, pointerId: 1 })
    fireEvent.pointerCancel(el, { pointerId: 1 })
    expect(onCommit).not.toHaveBeenCalled()
    expect(onPreview).toHaveBeenLastCalledWith(null)
  })

  it('ignores a right-click, and draws nothing for undated work', () => {
    const { part, onCommit } = renderHandles({ start: '2026-10-05', due: '2026-10-10' })
    fireEvent.pointerDown(part('move'), { button: 2, clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(part('move'), { clientX: 200, pointerId: 1 })
    fireEvent.pointerUp(part('move'), { clientX: 200, pointerId: 1 })
    expect(onCommit).not.toHaveBeenCalled()
    const none = renderHandles({ start: null, due: null })
    expect(none.part('move')).toBeNull()
  })
})
