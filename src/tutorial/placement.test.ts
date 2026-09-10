import { describe, expect, it } from 'vitest'
import { clipToViewport, MARGIN, placeCard, SHEET_BREAKPOINT, type Rect } from './placement.ts'

const DESKTOP = { width: 1280, height: 800 }
const CARD = { width: 352, height: 200 }

function inside(pos: { top: number; left: number }, card: { width: number; height: number }, vp: { width: number; height: number }) {
  return pos.top >= MARGIN && pos.left >= MARGIN &&
    pos.top + card.height <= vp.height - MARGIN + 0.001 &&
    pos.left + card.width <= vp.width - MARGIN + 0.001
}

describe('placing the explanation card', () => {
  it('prefers sitting below the highlighted control', () => {
    const pos = placeCard({ top: 100, left: 400, width: 200, height: 40 }, CARD, DESKTOP)
    expect(pos.placement).toBe('bottom')
    expect(pos.top).toBe(100 + 40 + 12)
  })

  it('goes above when there is no room below', () => {
    const pos = placeCard({ top: 700, left: 400, width: 200, height: 40 }, CARD, DESKTOP)
    expect(pos.placement).toBe('top')
  })

  it('honours a preferred side when it fits', () => {
    const pos = placeCard({ top: 300, left: 100, width: 200, height: 40 }, CARD, DESKTOP, 'right')
    expect(pos.placement).toBe('right')
  })

  it('centres when there is nothing to point at', () => {
    const pos = placeCard(null, CARD, DESKTOP)
    expect(pos.placement).toBe('center')
    expect(inside(pos, CARD, DESKTOP)).toBe(true)
  })

  it('becomes a bottom sheet on a phone', () => {
    const phone = { width: 375, height: 667 }
    expect(phone.width).toBeLessThan(SHEET_BREAKPOINT)
    expect(placeCard({ top: 50, left: 10, width: 300, height: 40 }, CARD, phone).placement).toBe('sheet')
  })

  it('never leaves the viewport, wherever the control is', () => {
    const viewports = [DESKTOP, { width: 1024, height: 700 }, { width: 800, height: 600 }, { width: 640, height: 500 }]
    for (const vp of viewports) {
      for (let top = -200; top <= vp.height + 200; top += 37) {
        for (let left = -200; left <= vp.width + 200; left += 53) {
          for (const size of [{ width: 20, height: 20 }, { width: 300, height: 60 }, { width: 2000, height: 1500 }]) {
            const pos = placeCard({ top, left, ...size }, CARD, vp)
            expect(inside(pos, CARD, vp), `card escaped at ${JSON.stringify({ vp, top, left, size, pos })}`).toBe(true)
          }
        }
      }
    }
  })

  it('stays inside even when the card is taller than the screen', () => {
    const tall = { width: 352, height: 900 }
    const pos = placeCard({ top: 100, left: 100, width: 50, height: 50 }, tall, DESKTOP)
    expect(pos.top).toBe(MARGIN)
    expect(pos.left).toBeGreaterThanOrEqual(MARGIN)
  })
})

describe('clipping the spotlight to the screen', () => {
  const vp = { width: 800, height: 600 }
  it('keeps what is on screen', () => {
    expect(clipToViewport({ top: -50, left: 100, width: 200, height: 100 }, vp)).toEqual({ top: 0, left: 100, width: 200, height: 50 })
  })
  it('returns null for something scrolled fully away', () => {
    const offscreen: Rect = { top: 900, left: 100, width: 200, height: 100 }
    expect(clipToViewport(offscreen, vp)).toBeNull()
  })
})
