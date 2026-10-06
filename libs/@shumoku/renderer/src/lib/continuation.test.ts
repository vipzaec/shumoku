import type { Node, ResolvedEdge, ResolvedLayout, Subgraph } from '@shumoku/core'
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

  it('moves a saved marker together with its endpoint block', () => {
    const connection = edge({
      enabled: true,
      label: '1C KEY',
      sourceRelative: { x: 80, y: 40 },
    })
    expect(continuationGeometry(connection)?.ends[0]).toMatchObject({ badgeX: 180, badgeY: 240 })
    connection.fromPort = {
      ...connection.fromPort,
      absolutePosition: { x: 220, y: 260 },
    }
    expect(continuationGeometry(connection)?.ends[0]).toMatchObject({ badgeX: 300, badgeY: 300 })
  })

  it('routes a moved marker around a lower nested service and rounds the turn', () => {
    const link = edge({
      enabled: true,
      label: '1C KEY',
      source: { x: 200, y: 330 },
    })
    link.fromNodeId = 'service'
    link.toNodeId = 'target'
    link.fromPort = {
      ...link.fromPort,
      absolutePosition: { x: 350, y: 100 },
      side: 'right',
    }
    const nodes = new Map<string, Node>([
      [
        'service',
        {
          id: 'service',
          label: '1C',
          parent: 'vm',
          position: { x: 300, y: 100 },
          size: { width: 100, height: 60 },
        },
      ],
      [
        'lower',
        {
          id: 'lower',
          label: 'MSSQL',
          parent: 'lower-group',
          position: { x: 320, y: 200 },
          size: { width: 100, height: 80 },
        },
      ],
    ])
    const subgraphs = new Map<string, Subgraph>([
      ['vm', { id: 'vm', label: 'SQL VM', bounds: { x: 200, y: 40, width: 300, height: 320 } }],
      [
        'lower-group',
        {
          id: 'lower-group',
          label: 'MSSQL',
          parent: 'vm',
          bounds: { x: 260, y: 150, width: 130, height: 100 },
        },
      ],
    ])
    const geometry = continuationGeometry(link, nodes, subgraphs)
    expect(geometry?.segments[0]?.length).toBeGreaterThan(2)
    expect(geometry?.path).toContain(' Q ')
    expect(geometry?.segments[0]?.[1]?.x).toBeGreaterThan(350)
    for (const [index, a] of (geometry?.segments[0] ?? []).entries()) {
      const b = geometry?.segments[0]?.[index + 1]
      if (!b) continue
      expect(a.x === b.x || a.y === b.y).toBe(true)
      expect(
        a.x === b.x
          ? a.x > 250 && a.x < 350 && Math.max(a.y, b.y) > 70 && Math.min(a.y, b.y) < 130
          : a.y > 70 && a.y < 130 && Math.max(a.x, b.x) > 250 && Math.min(a.x, b.x) < 350,
      ).toBe(false)
      expect(
        a.x === b.x
          ? a.x > 260 && a.x < 390 && Math.max(a.y, b.y) > 150 && Math.min(a.y, b.y) < 250
          : a.y > 150 && a.y < 250 && Math.max(a.x, b.x) > 260 && Math.min(a.x, b.x) < 390,
      ).toBe(false)
    }
  })

  it('keeps a straight continuation clear of a blocking card unless pass-under is selected', () => {
    const link = edge({
      enabled: true,
      label: 'LAN',
      source: { x: 210, y: 360 },
    })
    link.link.metadata = {
      ...link.link.metadata,
      routeShape: 'straight',
      routePolicy: 'avoid',
    }
    link.fromNodeId = 'source'
    link.toNodeId = 'target'
    link.fromPort = {
      ...link.fromPort,
      absolutePosition: { x: 350, y: 100 },
      side: 'right',
    }
    const nodes = new Map<string, Node>([
      [
        'source',
        {
          id: 'source',
          label: 'Source',
          position: { x: 300, y: 100 },
          size: { width: 100, height: 60 },
        },
      ],
      [
        'lower',
        {
          id: 'lower',
          label: 'Lower',
          position: { x: 320, y: 200 },
          size: { width: 100, height: 80 },
        },
      ],
    ])
    const groups = new Map<string, Subgraph>()
    const avoiding = continuationGeometry(link, nodes, groups)
    expect(avoiding?.segments[0]?.length).toBeGreaterThan(2)
    expect(avoiding?.path).toContain(' Q ')
    link.link.metadata = { ...link.link.metadata, routePolicy: 'under' }
    const passing = continuationGeometry(link, nodes, groups)
    expect(passing?.segments[0]).toHaveLength(2)
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
