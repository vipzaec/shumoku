import type { ResolvedEdge } from '@shumoku/core'
import { describe, expect, it } from 'vitest'
import { continuationGeometry } from './continuation'

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
})
