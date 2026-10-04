import type { ResolvedEdge, ResolvedLayout } from '@shumoku/core'
import { describe, expect, it } from 'vitest'
import {
  continuationBounds,
  continuationBoundsFromEdges,
  continuationGeometry,
} from './continuation'

function edge(config: unknown): ResolvedEdge {
  return {
    link: { metadata: { continuation: config } },
    fromPort: { side: 'right', absolutePosition: { x: 100, y: 200 } },
    toPort: { side: 'left', absolutePosition: { x: 500, y: 300 } },
  } as unknown as ResolvedEdge
}

describe('paired continuation geometry', () => {
  it('keeps two short visible stubs with the same label and no middle stroke', () => {
    const geometry = continuationGeometry(edge({ enabled: true, label: 'LAN-42', length: 48 }))
    expect(geometry?.label).toBe('LAN-42')
    expect(geometry?.path).toBe('M 100 200 L 148 200 M 500 300 L 452 300')
    expect(geometry?.ends.map((end) => end.badgeX)).toEqual([178, 422])
  })

  it('does not reinterpret ordinary or invalid links as continuations', () => {
    expect(continuationGeometry(edge({ enabled: false, label: 'LAN-42' }))).toBeNull()
    expect(continuationGeometry(edge({ enabled: true, label: '  ' }))).toBeNull()
  })

  it('places each marker independently without changing the logical endpoints', () => {
    const geometry = continuationGeometry(
      edge({
        enabled: true,
        label: 'MON-01',
        source: { x: 180, y: 240 },
        destination: { x: 420, y: 280 },
      }),
    )
    expect(geometry?.ends.map(({ badgeX, badgeY }) => [badgeX, badgeY])).toEqual([
      [180, 240],
      [420, 280],
    ])
    expect(geometry?.path).toContain('M 100 200 L')
    expect(geometry?.path).toContain('M 500 300 L')
  })

  it('expands export bounds to include independently moved markers', () => {
    const layout = {
      bounds: { x: 0, y: 0, width: 600, height: 400 },
      edges: new Map([
        [
          'link',
          edge({
            enabled: true,
            label: 'LAN-42',
            source: { x: -80, y: -30 },
            destination: { x: 670, y: 450 },
          }),
        ],
      ]),
    } as unknown as ResolvedLayout
    const expected = {
      x: -116,
      y: -42,
      width: 822,
      height: 504,
    }
    expect(continuationBounds(layout)).toEqual(expected)
    expect(continuationBoundsFromEdges(layout.bounds, layout.edges.values())).toEqual(expected)
  })
})
