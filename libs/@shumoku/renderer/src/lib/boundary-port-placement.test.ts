import { describe, expect, it } from 'vitest'

import { projectBoundaryPort } from './boundary-port-placement'

const vm = { x: 100, y: 200, width: 400, height: 300 }

describe('boundary port placement', () => {
  it('follows the parent outline continuously, then settles on a 1% anchor', () => {
    const preview = projectBoundaryPort(vm, { x: 104, y: 343 }, 'left', false)
    expect(preview.side).toBe('left')
    expect(preview.point).toEqual({ x: 100, y: 343 })
    expect(preview.offset).toBeCloseTo(143 / 300)

    const committed = projectBoundaryPort(vm, { x: 104, y: 343 }, 'left', true)
    expect(committed).toEqual({ side: 'left', offset: 0.48, point: { x: 100, y: 344 } })
  })

  it('does not jump to the top when the pointer drifts near the left corner', () => {
    expect(projectBoundaryPort(vm, { x: 108, y: 204 }, 'left', false).side).toBe('left')
    expect(projectBoundaryPort(vm, { x: 180, y: 204 }, 'left', false).side).toBe('top')
  })

  it('clamps anchors away from corners', () => {
    expect(projectBoundaryPort(vm, { x: 100, y: 195 }, 'left', true).offset).toBe(0.1)
    expect(projectBoundaryPort(vm, { x: 100, y: 510 }, 'left', true).offset).toBe(0.9)
  })
})
