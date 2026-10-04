// Lane offset router — invariant tests. The renderer collapses to a
// stub when ports are missing, so the test focus is on the lateral
// offset assignment: only edges sharing a port get an offset, the
// fan stays centred on zero, and lane order follows the peer's
// lateral coordinate so adjacent lanes never cross each other.

import { describe, expect, test } from 'vitest'
import type { Link, Node } from '../models/types.js'
import type { ResolvedPort } from './resolved-types.js'
import { routeEdges } from './route-edges.js'

function port(
  id: string,
  nodeId: string,
  x: number,
  y: number,
  side: ResolvedPort['side'],
): ResolvedPort {
  return {
    id,
    nodeId,
    label: id,
    absolutePosition: { x, y },
    side,
    size: { width: 6, height: 6 },
  }
}

function link(from: string, to: string): Link {
  const [fn, fp] = from.split(':')
  const [tn, tp] = to.split(':')
  return {
    from: { node: fn ?? '', port: fp ?? '' },
    to: { node: tn ?? '', port: tp ?? '' },
  }
}

function makePorts(entries: Array<[string, ResolvedPort]>): Map<string, ResolvedPort> {
  return new Map(entries)
}

const NOOP_NODES = new Map<string, Node>()

describe('routeEdges — obstacle avoidance', () => {
  const ports = makePorts([
    ['source:out', port('source:out', 'source', 0, 0, 'right')],
    ['target:in', port('target:in', 'target', 400, 200, 'left')],
  ])
  const obstacle = (id: string, x: number, y: number): Node => ({
    id,
    label: id,
    position: { x, y },
    size: { width: 80, height: 80 },
  })

  test('detours a diagonal connection around a node', async () => {
    const nodes = new Map([['middle', obstacle('middle', 200, 100)]])
    const edges = await routeEdges(nodes, ports, [link('source:out', 'target:in')])
    const points = [...edges.values()][0]?.route?.points
    expect(points?.length).toBeGreaterThan(2)
    for (const [i, a] of (points ?? []).entries()) {
      const b = points?.[i + 1]
      if (!b) continue
      expect(a.x === b.x || a.y === b.y).toBe(true)
      expect(
        a.x === b.x &&
          a.x > 160 &&
          a.x < 240 &&
          Math.max(a.y, b.y) > 60 &&
          Math.min(a.y, b.y) < 140,
      ).toBe(false)
      expect(
        a.y === b.y &&
          a.y > 60 &&
          a.y < 140 &&
          Math.max(a.x, b.x) > 160 &&
          Math.min(a.x, b.x) < 240,
      ).toBe(false)
    }
  })

  test('keeps the smooth route when no node blocks it', async () => {
    const nodes = new Map([['far', obstacle('far', 600, 600)]])
    const edges = await routeEdges(nodes, ports, [link('source:out', 'target:in')])
    expect([...edges.values()][0]?.route).toBeUndefined()
  })

  test('lets each link choose whether to pass under or avoid a blocking node', async () => {
    const nodes = new Map([['middle', obstacle('middle', 200, 100)]])
    const passing = {
      ...link('source:out', 'target:in'),
      metadata: { routePolicy: 'under' },
    }
    const avoiding = {
      ...link('source:out', 'target:in'),
      metadata: { routeMode: 'smooth', routePolicy: 'avoid' },
    }
    const under = await routeEdges(nodes, ports, [passing])
    const around = await routeEdges(nodes, ports, [avoiding])
    expect([...under.values()][0]?.route).toBeUndefined()
    expect([...around.values()][0]?.route?.points?.length).toBeGreaterThan(2)
  })

  test('smooth describes the line shape, while an obstacle still requires a detour', async () => {
    const nodes = new Map([['middle', obstacle('middle', 200, 100)]])
    const smooth = await routeEdges(nodes, ports, [
      { ...link('source:out', 'target:in'), metadata: { routeMode: 'smooth' } },
    ])
    expect([...smooth.values()][0]?.route?.points?.length).toBeGreaterThan(2)
    expect([...smooth.values()][0]?.route).toMatchObject({ cornerRadius: 12 })
  })

  test('an external connection detours around the outermost foreign group', async () => {
    const horizontalPorts = makePorts([
      ['source:out', port('source:out', 'source', 0, 100, 'right')],
      ['target:in', port('target:in', 'target', 400, 100, 'left')],
    ])
    const groups = new Map([
      ['outer', { id: 'outer', label: 'VM', bounds: { x: 140, y: 50, width: 120, height: 100 } }],
      [
        'inner',
        {
          id: 'inner',
          label: 'Service',
          parent: 'outer',
          bounds: { x: 170, y: 75, width: 50, height: 50 },
        },
      ],
      [
        'component',
        {
          id: 'component',
          label: 'Component',
          parent: 'inner',
          bounds: { x: 185, y: 85, width: 20, height: 30 },
        },
      ],
    ])
    const nodes = new Map<string, Node>([
      ['inner-node', { ...obstacle('inner-node', 195, 100), parent: 'component' }],
    ])
    const edges = await routeEdges(
      nodes,
      horizontalPorts,
      [{ ...link('source:out', 'target:in'), metadata: { routeMode: 'smooth' } }],
      groups,
    )
    const points = [...edges.values()][0]?.route?.points
    expect(points?.length).toBeGreaterThan(2)
    for (const [index, a] of (points ?? []).entries()) {
      const b = points?.[index + 1]
      if (!b) continue
      expect(
        a.y === b.y
          ? a.y > 50 && a.y < 150 && Math.max(a.x, b.x) > 140 && Math.min(a.x, b.x) < 260
          : a.x > 140 && a.x < 260 && Math.max(a.y, b.y) > 50 && Math.min(a.y, b.y) < 150,
      ).toBe(false)
    }
  })

  test('an outgoing service connection detours around a nested sibling group', async () => {
    const servicePorts = makePorts([
      ['service:out', port('service:out', 'service', 150, 100, 'right')],
      ['target:in', port('target:in', 'target', 500, 250, 'left')],
    ])
    const groups = new Map([
      ['vm', { id: 'vm', label: 'VM', bounds: { x: 100, y: 50, width: 350, height: 350 } }],
      [
        'sibling',
        {
          id: 'sibling',
          label: 'Other service',
          parent: 'vm',
          bounds: { x: 190, y: 110, width: 180, height: 130 },
        },
      ],
    ])
    const nodes = new Map<string, Node>([
      ['service', { ...obstacle('service', 150, 100), parent: 'vm' }],
      ['sibling-node', { ...obstacle('sibling-node', 280, 175), parent: 'sibling' }],
    ])
    const edges = await routeEdges(
      nodes,
      servicePorts,
      [{ ...link('service:out', 'target:in'), metadata: { routeMode: 'smooth' } }],
      groups,
    )
    const points = [...edges.values()][0]?.route?.points
    expect(points?.length).toBeGreaterThan(2)
    for (const [index, a] of (points ?? []).entries()) {
      const b = points?.[index + 1]
      if (!b) continue
      expect(
        a.y === b.y
          ? a.y > 110 && a.y < 240 && Math.max(a.x, b.x) > 190 && Math.min(a.x, b.x) < 370
          : a.x > 190 && a.x < 370 && Math.max(a.y, b.y) > 110 && Math.min(a.y, b.y) < 240,
      ).toBe(false)
    }
  })

  test('routes around an unrelated container after automatic placement', async () => {
    const groups = new Map([
      [
        'other-site',
        {
          id: 'other-site',
          label: 'Other site',
          bounds: { x: 160, y: -20, width: 100, height: 220 },
        },
      ],
    ])
    const avoiding = await routeEdges(NOOP_NODES, ports, [link('source:out', 'target:in')], groups)
    const passing = await routeEdges(
      NOOP_NODES,
      ports,
      [{ ...link('source:out', 'target:in'), metadata: { routePolicy: 'under' } }],
      groups,
    )
    expect([...avoiding.values()][0]?.route?.points?.length).toBeGreaterThan(2)
    expect([...passing.values()][0]?.route).toBeUndefined()
  })

  test('shortens a port stalk when a neighboring group nearly touches the target', async () => {
    const sitePorts = makePorts([
      ['site:wan', port('site:wan', 'site', 523.6, 1695, 'right')],
      ['office:wan', port('office:wan', 'office', 523.6, 1271, 'right')],
      ['gateway:wan', port('gateway:wan', 'gateway', 615.6, 903.2, 'left')],
    ])
    const groups = new Map([
      [
        'source-site',
        {
          id: 'source-site',
          label: 'Consulting',
          bounds: { x: -73.2, y: 1591, width: 660.8, height: 180 },
        },
      ],
      [
        'other-site',
        {
          id: 'other-site',
          label: 'Office',
          bounds: { x: -80.9, y: 1099, width: 668.5, height: 315 },
        },
      ],
      [
        'external',
        {
          id: 'external',
          label: 'External access',
          bounds: { x: -147.65, y: 214, width: 735.25, height: 877 },
        },
      ],
    ])
    const edges = await routeEdges(
      NOOP_NODES,
      sitePorts,
      [link('office:wan', 'gateway:wan'), link('site:wan', 'gateway:wan')],
      groups,
    )
    const [officeEdge, consultingEdge] = [...edges.values()]
    const points = consultingEdge?.route?.points
    expect(points?.length).toBeGreaterThan(2)
    expect(officeEdge?.route?.points?.length).toBeGreaterThan(2)
    expect(officeEdge?.route?.points?.[1]?.x).not.toBe(points?.[1]?.x)
    const office = { left: -80.9, right: 587.6, top: 1099, bottom: 1414 }
    for (const [index, point] of (points ?? []).entries()) {
      const next = points?.[index + 1]
      if (!next) continue
      const crosses =
        point.x === next.x
          ? point.x > office.left &&
            point.x < office.right &&
            Math.max(point.y, next.y) > office.top &&
            Math.min(point.y, next.y) < office.bottom
          : point.y === next.y &&
            point.y > office.top &&
            point.y < office.bottom &&
            Math.max(point.x, next.x) > office.left &&
            Math.min(point.x, next.x) < office.right
      expect(crosses).toBe(false)
    }
  })
})

describe('routeEdges — lane offset', () => {
  test('single edge per port has no lateral offset', async () => {
    const ports = makePorts([
      ['a:p1', port('a:p1', 'a', 0, 0, 'bottom')],
      ['b:p1', port('b:p1', 'b', 0, 100, 'top')],
    ])
    const edges = await routeEdges(NOOP_NODES, ports, [link('a:p1', 'b:p1')])
    const [edge] = [...edges.values()]
    expect(edge?.fromLateralOffset).toBeUndefined()
    expect(edge?.toLateralOffset).toBeUndefined()
  })

  test('fan-out of 2 (below bus threshold) gets symmetric lateral offsets', async () => {
    // 2 edges stay below the bus-routing threshold (=3) and fall
    // through to the lane-offset path.
    const ports = makePorts([
      ['hub:p1', port('hub:p1', 'hub', 100, 0, 'bottom')],
      ['c1:p1', port('c1:p1', 'c1', 50, 100, 'top')],
      ['c2:p1', port('c2:p1', 'c2', 150, 100, 'top')],
    ])
    const edges = await routeEdges(NOOP_NODES, ports, [
      link('hub:p1', 'c1:p1'),
      link('hub:p1', 'c2:p1'),
    ])
    const list = [...edges.values()]
    const offsets = list
      .sort((a, b) => a.toPort.absolutePosition.x - b.toPort.absolutePosition.x)
      .map((e) => e.fromLateralOffset)
    expect(offsets).toEqual([-4, 4])
    for (const e of list) {
      expect(e.toLateralOffset).toBeUndefined()
      expect(e.route).toBeUndefined()
    }
  })

  test('lane order follows peer x for top/bottom ports', async () => {
    // 2 edges (under bus threshold). hub at x=100, two children at
    // x=200 (right) and x=0 (left). Lanes should run -4, +4 sorted
    // left-to-right.
    const ports = makePorts([
      ['hub:p1', port('hub:p1', 'hub', 100, 0, 'bottom')],
      ['c1:p1', port('c1:p1', 'c1', 200, 100, 'top')],
      ['c2:p1', port('c2:p1', 'c2', 0, 100, 'top')],
    ])
    const edges = await routeEdges(NOOP_NODES, ports, [
      link('hub:p1', 'c1:p1'),
      link('hub:p1', 'c2:p1'),
    ])
    const get = (id: string) => [...edges.values()].find((e) => e.toPortId === id)
    // c2 is leftmost target → leftmost lane
    expect(get('c2:p1')?.fromLateralOffset).toBe(-4)
    expect(get('c1:p1')?.fromLateralOffset).toBe(4)
  })

  test('fan-out of 3+ from one node falls through to lateral-offset bezier', async () => {
    // Bus routing is currently disabled — every edge stays as
    // the default port-anchored bezier and the lane-offset pass
    // fans the source side.
    const ports = makePorts([
      ['hub:p1', port('hub:p1', 'hub', 100, 0, 'bottom')],
      ['hub:p2', port('hub:p2', 'hub', 110, 0, 'bottom')],
      ['hub:p3', port('hub:p3', 'hub', 120, 0, 'bottom')],
      ['c1:p', port('c1:p', 'c1', 50, 100, 'top')],
      ['c2:p', port('c2:p', 'c2', 100, 100, 'top')],
      ['c3:p', port('c3:p', 'c3', 150, 100, 'top')],
    ])
    const edges = await routeEdges(NOOP_NODES, ports, [
      link('hub:p1', 'c1:p'),
      link('hub:p2', 'c2:p'),
      link('hub:p3', 'c3:p'),
    ])
    const list = [...edges.values()]
    expect(list.length).toBe(3)
    for (const e of list) {
      expect(e.route).toBeUndefined()
    }
  })

  test('bus rejected when targets straddle different layers (Y spread too large)', async () => {
    // Two targets at y=100, one at y=500. Spread > BUS_MAX_TARGET_Y_SPREAD → no bus.
    const ports = makePorts([
      ['hub:p1', port('hub:p1', 'hub', 100, 0, 'bottom')],
      ['hub:p2', port('hub:p2', 'hub', 110, 0, 'bottom')],
      ['hub:p3', port('hub:p3', 'hub', 120, 0, 'bottom')],
      ['c1:p', port('c1:p', 'c1', 50, 100, 'top')],
      ['c2:p', port('c2:p', 'c2', 100, 100, 'top')],
      ['c3:p', port('c3:p', 'c3', 150, 500, 'top')],
    ])
    const edges = await routeEdges(NOOP_NODES, ports, [
      link('hub:p1', 'c1:p'),
      link('hub:p2', 'c2:p'),
      link('hub:p3', 'c3:p'),
    ])
    for (const e of edges.values()) {
      expect(e.route).toBeUndefined()
    }
  })

  test('fan-in: edges converging on one target port get target-side offsets', async () => {
    const ports = makePorts([
      ['s1:p', port('s1:p', 's1', 50, 0, 'bottom')],
      ['s2:p', port('s2:p', 's2', 100, 0, 'bottom')],
      ['s3:p', port('s3:p', 's3', 150, 0, 'bottom')],
      ['hub:p', port('hub:p', 'hub', 100, 100, 'top')],
    ])
    const edges = await routeEdges(NOOP_NODES, ports, [
      link('s1:p', 'hub:p'),
      link('s2:p', 'hub:p'),
      link('s3:p', 'hub:p'),
    ])
    const list = [...edges.values()].sort(
      (a, b) => a.fromPort.absolutePosition.x - b.fromPort.absolutePosition.x,
    )
    const offsets = list.map((e) => e.toLateralOffset)
    expect(offsets).toEqual([-8, 0, 8])
    // Each source is unique, so no source-side offset.
    for (const e of list) expect(e.fromLateralOffset).toBeUndefined()
  })

  test('group of 10+ edges shrinks stride to stay within the cap', async () => {
    // Default cap is 28px half-width → stride of (28*2)/(N-1) when
    // the natural stride would overflow. For N=10 the natural span
    // is 9 * 8 = 72px (half = 36) which exceeds 28; expect a
    // shrunk stride.
    const N = 10
    const entries: Array<[string, ResolvedPort]> = [
      ['hub:p', port('hub:p', 'hub', 100, 0, 'bottom')],
    ]
    const links: Link[] = []
    for (let i = 0; i < N; i++) {
      const id = `c${i}:p`
      entries.push([id, port(id, `c${i}`, i * 50, 100, 'top')])
      links.push(link('hub:p', id))
    }
    const edges = await routeEdges(NOOP_NODES, new Map(entries), links)
    const list = [...edges.values()]
    const offsets = list
      .filter((e) => e.fromLateralOffset !== undefined)
      .map((e) => e.fromLateralOffset as number)
      .sort((a, b) => a - b)
    // Symmetric around 0: pairwise sum is zero.
    for (let i = 0; i < offsets.length / 2; i++) {
      const lo = offsets[i] ?? 0
      const hi = offsets[offsets.length - 1 - i] ?? 0
      expect(lo + hi).toBeCloseTo(0, 5)
    }
    // Total half-width capped at 28.
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(28)
  })

  test('two unrelated fan-outs do not interfere', async () => {
    const ports = makePorts([
      ['h1:p', port('h1:p', 'h1', 0, 0, 'bottom')],
      ['h2:p', port('h2:p', 'h2', 200, 0, 'bottom')],
      ['a:p', port('a:p', 'a', -50, 100, 'top')],
      ['b:p', port('b:p', 'b', 50, 100, 'top')],
      ['c:p', port('c:p', 'c', 150, 100, 'top')],
      ['d:p', port('d:p', 'd', 250, 100, 'top')],
    ])
    const edges = await routeEdges(NOOP_NODES, ports, [
      link('h1:p', 'a:p'),
      link('h1:p', 'b:p'),
      link('h2:p', 'c:p'),
      link('h2:p', 'd:p'),
    ])
    const get = (id: string) => [...edges.values()].find((e) => e.id === id || e.toPortId === id)
    expect(get('a:p')?.fromLateralOffset).toBe(-4)
    expect(get('b:p')?.fromLateralOffset).toBe(4)
    expect(get('c:p')?.fromLateralOffset).toBe(-4)
    expect(get('d:p')?.fromLateralOffset).toBe(4)
  })
})
