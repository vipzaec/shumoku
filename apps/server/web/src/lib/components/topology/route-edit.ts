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

/** An empty hand-drawn route must return to automatic routing, not become a straight line. */
export function removeEditableRouteBend(bends: Point[], index: number): Point[] | null {
  const remaining = bends.filter((_, i) => i !== index)
  return remaining.length > 0 ? remaining : null
}

export function nonEmptyRouteOverrides(
  routes: Record<string, Point[]> | undefined,
): Record<string, Point[]> {
  return Object.fromEntries(Object.entries(routes ?? {}).filter(([, bends]) => bends.length > 0))
}
