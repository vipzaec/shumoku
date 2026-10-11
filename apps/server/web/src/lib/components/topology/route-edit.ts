import type { EdgeRoute } from '@shumoku/core'

type Point = { x: number; y: number }

/** The first manual edit continues the route currently visible on the canvas. */
export function editableRouteBends(
  saved: Point[] | undefined,
  route: EdgeRoute | undefined,
): Point[] {
  if (saved) return saved
  return route?.kind === 'polyline'
    ? route.points.slice(1, -1).map((point) => ({ x: point.x, y: point.y }))
    : []
}
