type Side = 'top' | 'bottom' | 'left' | 'right'

type Bounds = { x: number; y: number; width: number; height: number }
type Point = { x: number; y: number }

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
  const continuous = Math.max(0.1, Math.min(0.9, position / Math.max(length, 1)))
  // A one-percent landing grid avoids visible jumps on large blocks while
  // still producing stable, repeatable saved positions.
  const offset = snap ? Math.round(continuous * 100) / 100 : continuous
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
