import type { Side } from './steps.ts'

export type Rect = { top: number; left: number; width: number; height: number }
export type Size = { width: number; height: number }
export type Viewport = { width: number; height: number }
export type CardPlacement = Side | 'center' | 'sheet'
export type CardPosition = { top: number; left: number; placement: CardPlacement }

export const GAP = 12
export const MARGIN = 8
// Below this width the explanation becomes a bottom sheet instead of floating
// beside the highlighted control — there is no room beside anything on a phone.
export const SHEET_BREAKPOINT = 640

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

// The part of a rectangle that is actually on screen, or null if none is.
export function clipToViewport(rect: Rect, viewport: Viewport): Rect | null {
  const top = Math.max(rect.top, 0)
  const left = Math.max(rect.left, 0)
  const bottom = Math.min(rect.top + rect.height, viewport.height)
  const right = Math.min(rect.left + rect.width, viewport.width)
  if (bottom <= top || right <= left) return null
  return { top, left, width: right - left, height: bottom - top }
}

// Where the explanation card goes. The one guarantee: every result keeps the
// card inside the viewport. Tries the preferred side, then below, above, right
// and left; if the target fills the screen, the card sits over its lower edge.
export function placeCard(
  target: Rect | null,
  card: Size,
  viewport: Viewport,
  preferred?: Side,
): CardPosition {
  const maxLeft = viewport.width - card.width - MARGIN
  const maxTop = viewport.height - card.height - MARGIN

  if (viewport.width < SHEET_BREAKPOINT) {
    return { top: clamp(maxTop, MARGIN, maxTop), left: MARGIN, placement: 'sheet' }
  }
  if (!target) {
    return {
      top: clamp((viewport.height - card.height) / 2, MARGIN, maxTop),
      left: clamp((viewport.width - card.width) / 2, MARGIN, maxLeft),
      placement: 'center',
    }
  }

  const centredLeft = target.left + target.width / 2 - card.width / 2
  const centredTop = target.top + target.height / 2 - card.height / 2
  const below = target.top + target.height + GAP
  const above = target.top - GAP - card.height
  const right = target.left + target.width + GAP
  const left = target.left - GAP - card.width

  const candidates: Record<Side, { top: number; left: number; fits: boolean }> = {
    bottom: { top: below, left: centredLeft, fits: below + card.height <= viewport.height - MARGIN },
    top: { top: above, left: centredLeft, fits: above >= MARGIN },
    right: { top: centredTop, left: right, fits: right + card.width <= viewport.width - MARGIN },
    left: { top: centredTop, left, fits: left >= MARGIN },
  }

  const order = [...new Set<Side>([...(preferred ? [preferred] : []), 'bottom', 'top', 'right', 'left'])]
  for (const side of order) {
    const option = candidates[side]
    if (option.fits) {
      return {
        top: clamp(option.top, MARGIN, maxTop),
        left: clamp(option.left, MARGIN, maxLeft),
        placement: side,
      }
    }
  }
  return { top: clamp(maxTop, MARGIN, maxTop), left: clamp(centredLeft, MARGIN, maxLeft), placement: 'center' }
}
