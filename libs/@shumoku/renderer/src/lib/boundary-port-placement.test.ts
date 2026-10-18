import { describe, expect, it } from 'vitest'

import { boundaryPortOffsets, projectBoundaryPort } from './boundary-port-placement'

const vm = { x: 100, y: 200, width: 400, height: 300 }

describe('boundary port placement', () => {
  it('follows the outline continuously, then settles on a visible anchor', () => {
    const preview = projectBoundaryPort(vm, { x: 104, y: 343 }, 'left', false)
    expect(preview.side).toBe('left')
    expect(preview.point).toEqual({ x: 100, y: 343 })
    expect(preview.offset).toBeCloseTo(143 / 300)

    const committed = projectBoundaryPort(vm, { x: 104, y: 343 }, 'left', true)
    const nearest = boundaryPortOffsets(vm.height).reduce((best, offset) =>
      Math.abs(offset - preview.offset) < Math.abs(best - preview.offset) ? offset : best,
    )
    expect(committed).toEqual({
      side: 'left',
      offset: nearest,
      point: { x: 100, y: 200 + vm.height * nearest },
    })
  })

  it('adds attachment locations in proportion to the side length', () => {
    const short = boundaryPortOffsets(120)
    const long = boundaryPortOffsets(1200)
    expect(short.length).toBe(5)
    expect(long.length).toBe(59)
    expect(long.length).toBeGreaterThan(short.length * 10)
    expect((short[0] ?? 0) * 120).toBe(16)
    expect((long[0] ?? 0) * 1200).toBe(16)
    expect((1 - (long[long.length - 1] ?? 1)) * 1200).toBeCloseTo(16)
    expect(boundaryPortOffsets(24)).toEqual([0.5])
  })

  it('does not jump to the top when the pointer drifts near the left corner', () => {
    expect(projectBoundaryPort(vm, { x: 108, y: 204 }, 'left', false).side).toBe('left')
    expect(projectBoundaryPort(vm, { x: 180, y: 204 }, 'left', false).side).toBe('top')
  })

  it('clamps anchors away from corners', () => {
    expect(projectBoundaryPort(vm, { x: 100, y: 195 }, 'left', true).offset).toBe(16 / 300)
    expect(projectBoundaryPort(vm, { x: 100, y: 510 }, 'left', true).offset).toBe(284 / 300)
  })
})
