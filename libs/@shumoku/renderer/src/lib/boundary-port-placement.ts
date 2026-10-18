type Side = 'top' | 'bottom' | 'left' | 'right'

type Bounds = { x: number; y: number; width: number; height: number }
type Point = { x: number; y: number }

const ANCHOR_SPACING = 20
const CORNER_CLEARANCE = 16

/** Attachment locations spaced by diagram units, independent of side length. */
export function boundaryPortOffsets(length: number): number[] {
  if (!Number.isFinite(length) || length <= CORNER_CLEARANCE * 2) return [0.5]
  const usable = length - CORNER_CLEARANCE * 2
  const intervals = Math.max(1, Math.round(usable / ANCHOR_SPACING))
  return Array.from(
    { length: intervals + 1 },
    (_, index) => (CORNER_CLEARANCE + (usable * index) / intervals) / length,
  )
}

export function projectBoundaryPort(
  bounds: Bounds,
  pointer: Point,
  currentSide: Side,
  snap: boolean,
): { side: Side; offset: number; point: Point } {
  const distances: Record<Side, number> = {
    left: Math.abs(pointer.x - bounds.x),
    right: Math.abs(pointer.x - bounds.x - bounds.width),
    top: Math.abs(pointer.y - bounds.y),
    bottom: Math.abs(pointer.y - bounds.y - bounds.height),
  }
  const nearest = (Object.keys(distances) as Side[]).reduce((best, side) =>
    distances[side] < distances[best] ? side : best,
  )
  // A small excursion from the outline must not flip the point to an
  // adjacent side. Switching remains possible by dragging near that side.
  const side = distances[nearest] + 20 < distances[currentSide] ? nearest : currentSide
  const horizontal = side === 'top' || side === 'bottom'
  const position = horizontal ? pointer.x - bounds.x : pointer.y - bounds.y
  const length = horizontal ? bounds.width : bounds.height
  const anchors = boundaryPortOffsets(length)
  const continuous = Math.max(
    anchors[0] ?? 0.5,
    Math.min(anchors[anchors.length - 1] ?? 0.5, position / Math.max(length, 1)),
  )
  // Keep the drag preview continuous; commit to the same fixed-distance
  // anchors that the canvas shows, on every block regardless of its size.
  const offset = snap
    ? anchors.reduce((nearest, candidate) =>
        Math.abs(candidate - continuous) < Math.abs(nearest - continuous) ? candidate : nearest,
      )
    : continuous
  return {
    side,
    offset,
    point: {
      x:
        side === 'left'
          ? bounds.x
          : side === 'right'
            ? bounds.x + bounds.width
            : bounds.x + bounds.width * offset,
      y:
        side === 'top'
          ? bounds.y
          : side === 'bottom'
            ? bounds.y + bounds.height
            : bounds.y + bounds.height * offset,
    },
  }
}
