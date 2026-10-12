// bezier-path lateralOffset coverage. The path generator should:
//   - leave the existing (no-offset) shape unchanged when offset is 0
//   - keep both endpoints attached to their ports while shifting only
//     the adjacent control points
//   - leave the SOURCE x intact when only `to.lateralOffset` is set
//     (i.e. offsets are scoped to their own endpoint)
//   - produce two distinct paths for two lanes at the same port

import { expect, test } from 'vitest'
import { bezierEdgePath } from './bezier-path.js'

function parseSvgPath(d: string): number[] {
  // "M x y C cx1 cy1 cx2 cy2 ex ey" → [x, y, cx1, cy1, cx2, cy2, ex, ey]
  return d.replace(/[MC]/g, '').trim().split(/\s+/).map(Number)
}

test('lateralOffset=0 matches the no-offset path verbatim', () => {
  const a = { absolutePosition: { x: 0, y: 0 }, side: 'bottom' as const }
  const b = { absolutePosition: { x: 0, y: 100 }, side: 'top' as const }
  expect(bezierEdgePath({ ...a, lateralOffset: 0 }, b)).toBe(bezierEdgePath(a, b))
})

test('original smooth reach stays on distant nodes and shrinks when a node moves behind a port', () => {
  const from = { absolutePosition: { x: 0, y: 0 }, side: 'right' as const }
  const far = parseSvgPath(
    bezierEdgePath(from, { absolutePosition: { x: 800, y: 150 }, side: 'left' }),
  )
  const reversed = parseSvgPath(
    bezierEdgePath(from, { absolutePosition: { x: -50, y: 150 }, side: 'left' }),
  )
  expect(far[2]).toBe(320)
  expect(reversed[2]).toBe(0)
})

test('each end reduces its own radius as the opposite block approaches its normal', () => {
  const from = { absolutePosition: { x: 0, y: 0 }, side: 'right' as const }
  const far = parseSvgPath(
    bezierEdgePath(from, { absolutePosition: { x: 300, y: 100 }, side: 'top' }),
  )
  const near = parseSvgPath(
    bezierEdgePath(from, { absolutePosition: { x: 10, y: 100 }, side: 'top' }),
  )
  expect(far[2]).toBe(180)
  expect(near[2]).toBe(6)
  // The target still has 100 units of vertical clearance, so its own
  // tangent stays smooth instead of inheriting the source's short reach.
  expect(far[5]).toBe(40)
  expect(near[5]).toBe(40)
})

test('positive fromLateralOffset on a bottom port fans right without detaching', () => {
  const a = { absolutePosition: { x: 0, y: 0 }, side: 'bottom' as const }
  const b = { absolutePosition: { x: 0, y: 100 }, side: 'top' as const }
  const base = parseSvgPath(bezierEdgePath(a, b))
  const shifted = parseSvgPath(bezierEdgePath({ ...a, lateralOffset: 5 }, b))
  expect(shifted[0]).toBeCloseTo(base[0] ?? 0, 5)
  expect(shifted[2]).toBeCloseTo((base[2] ?? 0) + 5, 5)
  expect(shifted[6]).toBeCloseTo(base[6] ?? 0, 5)
})

test('toLateralOffset on a top port fans the arrival without moving the target', () => {
  const a = { absolutePosition: { x: 0, y: 0 }, side: 'bottom' as const }
  const b = { absolutePosition: { x: 0, y: 100 }, side: 'top' as const }
  const base = parseSvgPath(bezierEdgePath(a, b))
  const shifted = parseSvgPath(bezierEdgePath(a, { ...b, lateralOffset: 7 }))
  expect(shifted[0]).toBeCloseTo(base[0] ?? 0, 5)
  expect(shifted[6]).toBeCloseTo(base[6] ?? 0, 5)
  expect(Math.abs((shifted[4] ?? 0) - (base[4] ?? 0))).toBeCloseTo(7, 5)
})

test('two opposite-sign offsets at the same port produce distinct paths', () => {
  const a = { absolutePosition: { x: 50, y: 0 }, side: 'bottom' as const }
  const b1 = { absolutePosition: { x: 0, y: 100 }, side: 'top' as const }
  const b2 = { absolutePosition: { x: 100, y: 100 }, side: 'top' as const }
  const left = bezierEdgePath({ ...a, lateralOffset: -8 }, b1)
  const right = bezierEdgePath({ ...a, lateralOffset: 8 }, b2)
  expect(left).not.toBe(right)
  const leftPts = parseSvgPath(left)
  const rightPts = parseSvgPath(right)
  expect(leftPts[0]).toBe(rightPts[0])
  expect(leftPts[2]).toBeLessThan(rightPts[2] ?? 0)
})

test('lateralOffset on a left/right port shifts perpendicular (vertical)', () => {
  const a = { absolutePosition: { x: 0, y: 50 }, side: 'right' as const }
  const b = { absolutePosition: { x: 100, y: 50 }, side: 'left' as const }
  const base = parseSvgPath(bezierEdgePath(a, b))
  const shifted = parseSvgPath(bezierEdgePath({ ...a, lateralOffset: 6 }, b))
  // Endpoint stays attached; only its control point moves vertically.
  expect(shifted[0]).toBeCloseTo(base[0] ?? 0, 5)
  expect(shifted[1]).toBeCloseTo(base[1] ?? 0, 5)
  expect(Math.abs((shifted[3] ?? 0) - (base[3] ?? 0))).toBeCloseTo(6, 5)
})
