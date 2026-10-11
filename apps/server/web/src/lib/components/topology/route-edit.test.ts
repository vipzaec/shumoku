import { describe, expect, it } from 'vitest'
import { editableRouteBends, nonEmptyRouteOverrides, removeEditableRouteBend } from './route-edit'

const route = {
  kind: 'polyline' as const,
  points: [
    { x: 0, y: 0 },
    { x: 40, y: -20 },
    { x: 80, y: -20 },
    { x: 120, y: 0 },
  ],
}

describe('manual route editing', () => {
  it('keeps existing automatic bends when the first new point is added', () => {
    const bends = editableRouteBends(undefined, route)
    bends.splice(1, 0, { x: 60, y: -40 })
    expect(bends).toEqual([
      { x: 40, y: -20 },
      { x: 60, y: -40 },
      { x: 80, y: -20 },
    ])
    expect(route.points).toHaveLength(4)
  })

  it('honors an explicitly cleared manual route instead of restoring automatic bends', () => {
    expect(editableRouteBends([], route)).toEqual([])
  })

  it('restores automatic routing when the final hand-drawn bend is removed', () => {
    expect(removeEditableRouteBend([{ x: 60, y: -40 }], 0)).toBeNull()
    expect(
      removeEditableRouteBend(
        [
          { x: 40, y: -20 },
          { x: 60, y: -40 },
        ],
        0,
      ),
    ).toEqual([{ x: 60, y: -40 }])
  })

  it('ignores old empty route overrides when loading a saved layout', () => {
    expect(nonEmptyRouteOverrides({ cleared: [], handDrawn: [{ x: 60, y: -40 }] })).toEqual({
      handDrawn: [{ x: 60, y: -40 }],
    })
  })
})
