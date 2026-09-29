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
  const config = value as { enabled?: unknown; label?: unknown; length?: unknown }
  if (config.enabled !== true || typeof config.label !== 'string' || !config.label.trim())
    return null
  if (!edge.fromPort || !edge.toPort) return null
  const length =
    typeof config.length === 'number' && Number.isFinite(config.length)
      ? Math.max(28, Math.min(160, config.length))
      : 48
  const end = (port: NonNullable<typeof edge.fromPort>) => {
    const { x, y } = port.absolutePosition
    const normal =
      port.side === 'left'
        ? { x: -1, y: 0 }
        : port.side === 'top'
          ? { x: 0, y: -1 }
          : port.side === 'bottom'
            ? { x: 0, y: 1 }
            : { x: 1, y: 0 }
    return {
      x: x + normal.x * length,
      y: y + normal.y * length,
      badgeX: x + normal.x * (length + 30),
      badgeY: y + normal.y * (length + 30),
      startX: x,
      startY: y,
    }
  }
  const from = end(edge.fromPort)
  const to = end(edge.toPort)
  return {
    label: config.label.trim(),
    path: `M ${from.startX} ${from.startY} L ${from.x} ${from.y} M ${to.startX} ${to.startY} L ${to.x} ${to.y}`,
    ends: [from, to],
  }
}
