import {
  type Node,
  type Position,
  type ResolvedEdge,
  type ResolvedLayout,
  routeContinuationStub,
  type Subgraph,
} from '@shumoku/core'
import { polylinePath } from './svg-coords'

export interface ContinuationGeometry {
  label: string
  path: string
  ends: Array<{ x: number; y: number; badgeX: number; badgeY: number }>
  segments: Position[][]
}

/** Two visual stubs of one logical link; the missing middle is intentional. */
export function continuationGeometry(
  edge: ResolvedEdge,
  nodes?: Map<string, Node>,
  subgraphs?: Map<string, Subgraph>,
): ContinuationGeometry | null {
  const value = edge.link?.metadata?.['continuation']
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const config = value as {
    enabled?: unknown
    label?: unknown
    length?: unknown
    source?: unknown
    destination?: unknown
  }
  if (config.enabled !== true || typeof config.label !== 'string' || !config.label.trim())
    return null
  if (!edge.fromPort || !edge.toPort) return null
  const length =
    typeof config.length === 'number' && Number.isFinite(config.length)
      ? Math.max(28, Math.min(160, config.length))
      : 48
  const end = (port: NonNullable<typeof edge.fromPort>, position: unknown) => {
    const { x, y } = port.absolutePosition
    const normal =
      port.side === 'left'
        ? { x: -1, y: 0 }
        : port.side === 'top'
          ? { x: 0, y: -1 }
          : port.side === 'bottom'
            ? { x: 0, y: 1 }
            : { x: 1, y: 0 }
    const placed: Position | null =
      position &&
      typeof position === 'object' &&
      'x' in position &&
      'y' in position &&
      typeof position.x === 'number' &&
      typeof position.y === 'number' &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y)
        ? { x: position.x, y: position.y }
        : null
    const badgeX = placed?.x ?? x + normal.x * (length + 30)
    const badgeY = placed?.y ?? y + normal.y * (length + 30)
    const dx = badgeX - x
    const dy = badgeY - y
    const distance = Math.hypot(dx, dy)
    const stubLength = Math.max(0, distance - 30)
    const direction = distance > 0 ? { x: dx / distance, y: dy / distance } : normal
    return {
      x: x + direction.x * stubLength,
      y: y + direction.y * stubLength,
      badgeX,
      badgeY,
      startX: x,
      startY: y,
    }
  }
  const from = end(edge.fromPort, config.source)
  const to = end(edge.toPort, config.destination)
  const segments: Position[][] = [
    nodes && subgraphs
      ? routeContinuationStub(edge, 'source', { x: from.x, y: from.y }, nodes, subgraphs)
      : [
          { x: from.startX, y: from.startY },
          { x: from.x, y: from.y },
        ],
    nodes && subgraphs
      ? routeContinuationStub(edge, 'destination', { x: to.x, y: to.y }, nodes, subgraphs)
      : [
          { x: to.startX, y: to.startY },
          { x: to.x, y: to.y },
        ],
  ]
  return {
    label: config.label.trim(),
    path: segments.map((points) => polylinePath(points, 12)).join(' '),
    ends: [from, to],
    segments,
  }
}

/** Include movable continuation badges when fitting an exported diagram. */
export function continuationBounds(layout: ResolvedLayout) {
  return continuationBoundsFromEdges(
    layout.bounds,
    layout.edges.values(),
    layout.nodes,
    layout.subgraphs,
  )
}

/** Use the same fit bounds for the interactive canvas and static exports. */
export function continuationBoundsFromEdges(
  bounds: { x: number; y: number; width: number; height: number },
  edges: Iterable<ResolvedEdge>,
  nodes?: Map<string, Node>,
  subgraphs?: Map<string, Subgraph>,
) {
  const { x, y, width, height } = bounds
  let minX = x
  let minY = y
  let maxX = x + width
  let maxY = y + height
  for (const edge of edges) {
    const geometry = continuationGeometry(edge, nodes, subgraphs)
    if (!geometry) continue
    for (const end of geometry.ends) {
      minX = Math.min(minX, end.badgeX - 36, end.x)
      minY = Math.min(minY, end.badgeY - 12, end.y)
      maxX = Math.max(maxX, end.badgeX + 36, end.x)
      maxY = Math.max(maxY, end.badgeY + 12, end.y)
    }
    for (const point of geometry.segments.flat()) {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
