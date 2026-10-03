import type { ResolvedEdge } from '@shumoku/core'

export interface ContinuationGeometry {
  label: string
  path: string
  ends: Array<{ x: number; y: number; badgeX: number; badgeY: number }>
}

/** Two visual stubs of one logical link; the missing middle is intentional. */
export function continuationGeometry(edge: ResolvedEdge): ContinuationGeometry | null {
  const value = edge.link?.metadata?.continuation
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
    const placed =
      position &&
      typeof position === 'object' &&
      'x' in position &&
      'y' in position &&
      typeof position.x === 'number' &&
      typeof position.y === 'number' &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.y)
        ? position
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
  return {
    label: config.label.trim(),
    path: `M ${from.startX} ${from.startY} L ${from.x} ${from.y} M ${to.startX} ${to.startY} L ${to.x} ${to.y}`,
    ends: [from, to],
  }
}
