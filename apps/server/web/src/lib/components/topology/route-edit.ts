import type { EdgeRoute, ResolvedLayout } from '@shumoku/core'

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

/** Renderer captures live node positions, but its edges include temporary hand-drawn routes.
 * Keep the captured positions while retaining automatic routes as the base for a later reset. */
export function preserveAutomaticRoutes(
  current: ResolvedLayout,
  base: ResolvedLayout | null,
  routes: Record<string, Point[]>,
): ResolvedLayout {
  if (!base || Object.keys(routes).length === 0) return current
  const edges = new Map(current.edges)
  for (const id of Object.keys(routes)) {
    const live = edges.get(id)
    const automatic = base.edges.get(id)
    if (!live || !automatic) continue
    const start = live.fromPort.absolutePosition
    const end = live.toPort.absolutePosition
    const points = automatic.route
      ? [start, ...automatic.route.points.slice(1, -1), end]
      : [start, end]
    edges.set(id, {
      ...live,
      points,
      route: automatic.route ? { ...automatic.route, points } : undefined,
      labelAnchor: automatic.labelAnchor,
    })
  }
  return { ...current, edges }
}
