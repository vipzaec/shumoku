import { describe, expect, it } from 'vitest'
import type { Link, Node, Subgraph } from '../models/types.js'
import {
  collectPeerObstacles,
  isPortLinked,
  linkExists,
  moveNode,
  moveSubgraph,
  nodesOverlap,
  placeNode,
  rebalanceSubgraphs,
  resolveNodePosition,
} from './interaction.js'
import type { ResolvedPort } from './resolved-types.js'
import { routeEdges } from './route-edges.js'

const link = (id: string, fromN: string, fromP: string, toN: string, toP: string): Link => ({
  id,
  from: { node: fromN, port: fromP },
  to: { node: toN, port: toP },
})

describe('isPortLinked', () => {
  it('returns false for an empty link set', () => {
    expect(isPortLinked([], 'sw1', 'eth0')).toBe(false)
  })

  it('returns true when the port appears as the from endpoint', () => {
    const links = [link('l1', 'sw1', 'eth0', 'sw2', 'eth0')]
    expect(isPortLinked(links, 'sw1', 'eth0')).toBe(true)
  })

  it('returns true when the port appears as the to endpoint', () => {
    const links = [link('l1', 'sw1', 'eth0', 'sw2', 'eth0')]
    expect(isPortLinked(links, 'sw2', 'eth0')).toBe(true)
  })

  it('returns false for an unrelated port on a linked node', () => {
    const links = [link('l1', 'sw1', 'eth0', 'sw2', 'eth0')]
    expect(isPortLinked(links, 'sw1', 'eth1')).toBe(false)
  })

  it('returns false for the same port id on a different node', () => {
    const links = [link('l1', 'sw1', 'eth0', 'sw2', 'eth0')]
    expect(isPortLinked(links, 'sw3', 'eth0')).toBe(false)
  })
})

describe('linkExists vs isPortLinked', () => {
  // Sanity check: linkExists only guards exact-link duplicates, while
  // isPortLinked enforces the "one link per port" invariant. The
  // multi-link-per-port bug came from conflating the two.
  it('linkExists is false when a port already has a different partner', () => {
    const links = [link('l1', 'sw1', 'eth0', 'sw2', 'eth0')]
    // Try a brand-new link from sw3 onto sw1:eth0 (already in use).
    expect(linkExists(links, 'sw3', 'eth0', 'sw1', 'eth0')).toBe(false)
    expect(isPortLinked(links, 'sw1', 'eth0')).toBe(true)
  })
})

describe('outer spacing', () => {
  it('reserves each requested side between a child block and its parent contour', () => {
    const nodes = new Map<string, Node>([
      [
        'vm',
        {
          id: 'vm',
          label: 'VM',
          spec: { kind: 'hardware', type: 'server' },
          parent: 'host',
          position: { x: 200, y: 200 },
          size: { width: 100, height: 80 },
          style: { outerSpacing: { left: 90, right: 10, top: 35, bottom: 5 } },
        },
      ],
    ])
    const subgraphs = new Map<string, Subgraph>([['host', { id: 'host', label: 'ESXi' }]])
    rebalanceSubgraphs(nodes, subgraphs, new Map(), {
      subgraphPadding: 20,
      subgraphLabelHeight: 28,
    })
    const bounds = subgraphs.get('host')?.bounds
    expect(bounds).toBeDefined()
    expect(bounds?.x).toBe(40)
    expect(bounds?.y).toBe(77)
    expect(bounds?.width).toBe(240)
    expect(bounds?.height).toBe(188)
  })
})

describe('hierarchy-aware placement', () => {
  const candidate: Node = {
    id: 'candidate',
    label: 'Service',
    parent: 'vm',
    size: { width: 100, height: 60 },
  }
  const nodes = new Map<string, Node>([
    [
      'foreign-service',
      {
        id: 'foreign-service',
        label: 'Foreign service',
        parent: 'other-vm',
        position: { x: 300, y: 250 },
        size: { width: 100, height: 60 },
      },
    ],
    [
      'peer',
      {
        id: 'peer',
        label: 'Peer',
        parent: 'vm',
        position: { x: 500, y: 250 },
        size: { width: 100, height: 60 },
      },
    ],
  ])
  const subgraphs = new Map<string, Subgraph>([
    ['vm', { id: 'vm', bounds: { x: 100, y: 100, width: 600, height: 400 } }],
    ['other-vm', { id: 'other-vm', bounds: { x: 100, y: 100, width: 500, height: 400 } }],
    [
      'nested-peer',
      { id: 'nested-peer', parent: 'vm', bounds: { x: 600, y: 200, width: 100, height: 100 } },
    ],
  ])

  it('places every new child near its requested position despite overlapping foreign groups', () => {
    expect(placeNode(candidate, { nodes, subgraphs }, { x: 300, y: 250 })).toEqual({
      x: 300,
      y: 250,
    })
  })

  it('uses the same peer scope for the legacy position resolver', () => {
    const positioned = new Map(nodes).set(candidate.id, {
      ...candidate,
      position: { x: 300, y: 250 },
    })
    expect(resolveNodePosition(candidate.id, 308, 255, positioned, 8, subgraphs)).toEqual({
      x: 308,
      y: 255,
    })
  })

  it('still avoids nodes and group outlines in the same container', () => {
    const peerPlacement = placeNode(candidate, { nodes, subgraphs }, { x: 500, y: 250 })
    expect(
      nodesOverlap({ ...peerPlacement, w: 100, h: 60 }, { x: 500, y: 250, w: 100, h: 60 }),
    ).toBe(false)
    const groupPlacement = placeNode(candidate, { nodes, subgraphs }, { x: 650, y: 250 })
    expect(
      nodesOverlap({ ...groupPlacement, w: 100, h: 60 }, { x: 650, y: 250, w: 100, h: 100 }),
    ).toBe(false)
    expect(collectPeerObstacles(candidate.id, candidate.parent, nodes, subgraphs)).toHaveLength(2)
  })

  it('does not eject a nested block during automatic hull recalculation', () => {
    const childNodes = new Map<string, Node>([
      [
        'service',
        {
          ...candidate,
          id: 'service',
          position: { x: 300, y: 250 },
        },
      ],
    ])
    const overlappingGroups = new Map<string, Subgraph>([
      ['vm', { id: 'vm', parent: 'tenant', bounds: { x: 200, y: 180, width: 200, height: 140 } }],
      [
        'foreign-vm',
        {
          id: 'foreign-vm',
          parent: 'msp',
          bounds: { x: 200, y: 180, width: 200, height: 140 },
        },
      ],
    ])

    rebalanceSubgraphs(childNodes, overlappingGroups, new Map())

    expect(childNodes.get('service')?.position).toEqual({ x: 300, y: 250 })
  })
})

describe('manual group movement', () => {
  it('does not eject a service from its parent when unrelated group hulls overlap it', async () => {
    const parentBounds = { x: 100, y: 100, width: 400, height: 300 }
    const nodes = new Map<string, Node>([
      [
        'service',
        {
          id: 'service',
          label: 'MSSQL',
          parent: 'vm',
          position: { x: 300, y: 250 },
          size: { width: 100, height: 60 },
        },
      ],
      [
        'other-service',
        {
          id: 'other-service',
          label: 'Other service',
          parent: 'other-vm',
          position: { x: 300, y: 250 },
          size: { width: 100, height: 60 },
        },
      ],
    ])
    const subgraphs = new Map<string, Subgraph>([
      ['vm', { id: 'vm', bounds: parentBounds }],
      ['other-vm', { id: 'other-vm', bounds: { x: 80, y: 80, width: 500, height: 400 } }],
    ])

    const moved = await moveNode('service', 308, 255, { nodes, ports: new Map(), subgraphs }, [])

    expect(moved?.nodes.get('service')?.position).toEqual({ x: 308, y: 255 })
    expect(moved?.nodes.get('other-service')?.position).toEqual({ x: 300, y: 250 })
    expect(moved?.subgraphs?.get('vm')?.bounds).toEqual(parentBounds)
    expect(moved?.subgraphs?.get('other-vm')?.bounds).toEqual(subgraphs.get('other-vm')?.bounds)
  })

  it('keeps a resized outer container when an inner block moves', async () => {
    const outerBounds = { x: 0, y: 0, width: 500, height: 350 }
    const nodes = new Map<string, Node>([
      [
        'service',
        {
          id: 'service',
          label: 'Service',
          parent: 'vm',
          position: { x: 180, y: 160 },
          size: { width: 100, height: 60 },
        },
      ],
    ])
    const subgraphs = new Map<string, Subgraph>([
      ['vm', { id: 'vm', label: 'VM', bounds: outerBounds }],
    ])
    const moved = await moveNode('service', 220, 180, { nodes, ports: new Map(), subgraphs }, [])
    expect(moved?.nodes.get('service')?.position).toEqual({ x: 220, y: 180 })
    expect(moved?.subgraphs?.get('vm')?.bounds).toEqual(outerBounds)
  })

  it('moves only the selected group and leaves a neighboring group in place', async () => {
    const nodes = new Map<string, Node>([
      [
        'a',
        {
          id: 'a',
          label: 'A',
          parent: 'group-a',
          position: { x: 100, y: 100 },
          size: { width: 60, height: 40 },
        },
      ],
      [
        'b',
        {
          id: 'b',
          label: 'B',
          parent: 'group-b',
          position: { x: 300, y: 100 },
          size: { width: 60, height: 40 },
        },
      ],
    ])
    const subgraphs = new Map<string, Subgraph>([
      ['group-a', { id: 'group-a', bounds: { x: 50, y: 50, width: 100, height: 100 } }],
      ['group-b', { id: 'group-b', bounds: { x: 250, y: 50, width: 100, height: 100 } }],
    ])
    const moved = await moveSubgraph(
      'group-a',
      230,
      50,
      {
        nodes,
        ports: new Map(),
        subgraphs,
      },
      [],
    )
    expect(moved?.nodes.get('a')?.position).toEqual({ x: 280, y: 100 })
    expect(moved?.nodes.get('b')?.position).toEqual({ x: 300, y: 100 })
    expect(moved?.subgraphs.get('group-b')?.bounds).toEqual({
      x: 250,
      y: 50,
      width: 100,
      height: 100,
    })
  })
})

describe('shared subgraph boundary port', () => {
  it('places one LAN point on the VM outline and routes every service from it', async () => {
    const boundary: Node = {
      id: 'vm-lan',
      label: '',
      parent: 'vm',
      position: { x: 100, y: 130 },
      metadata: { presentationRole: 'subgraph-boundary-port' },
      ports: [
        { id: 'lan', label: 'LAN', connectors: [], placement: { side: 'left', offset: 0.5 } },
      ],
    }
    const service = (id: string, y: number): Node => ({
      id,
      label: id,
      parent: 'vm',
      position: { x: 250, y },
      size: { width: 100, height: 60 },
    })
    const nodes = new Map<string, Node>([
      [boundary.id, boundary],
      ['app', service('app', 110)],
      ['db', service('db', 210)],
      [
        'segment',
        {
          id: 'segment',
          label: 'LAN segment',
          position: { x: 0, y: 160 },
          size: { width: 80, height: 60 },
        },
      ],
    ])
    const subgraphs = new Map<string, Subgraph>([['vm', { id: 'vm', label: 'VM' }]])
    const lanPort: ResolvedPort = {
      id: 'vm-lan:lan',
      nodeId: 'vm-lan',
      label: 'LAN',
      side: 'left',
      absolutePosition: { x: 100, y: 130 },
      size: { width: 8, height: 8 },
    }
    const ports = new Map<string, ResolvedPort>([
      [lanPort.id, lanPort],
      ...[
        ['segment:p', 'segment', 0, 160, 'right'],
        ['app:p', 'app', 200, 110, 'left'],
        ['db:p', 'db', 200, 210, 'left'],
      ].map(
        ([id, nodeId, x, y, side]) =>
          [
            id as string,
            {
              id: id as string,
              nodeId: nodeId as string,
              label: '',
              absolutePosition: { x: x as number, y: y as number },
              side: side as ResolvedPort['side'],
              size: { width: 8, height: 8 },
            } as ResolvedPort,
          ] as const,
      ),
    ])
    rebalanceSubgraphs(nodes, subgraphs, ports)
    const box = subgraphs.get('vm')?.bounds
    expect(box).toBeDefined()
    if (!box) throw new Error('VM boundary missing')
    expect(ports.get('vm-lan:lan')?.absolutePosition.x).toBe(box?.x)
    expect(ports.get('vm-lan:lan')?.absolutePosition.y).toBe(box.y + box.height / 2)
    const links = [
      link('ingress', 'segment', 'p', 'vm-lan', 'lan'),
      link('app', 'vm-lan', 'lan', 'app', 'p'),
      link('db', 'vm-lan', 'lan', 'db', 'p'),
    ]
    const edges = await routeEdges(nodes, ports, links, subgraphs)
    expect(edges.size).toBe(3)
    expect(edges.get('app')?.fromPortId).toBe('vm-lan:lan')
    expect(edges.get('db')?.fromPortId).toBe('vm-lan:lan')
    expect(edges.get('app')?.fromLateralOffset).toBeGreaterThan(
      edges.get('db')?.fromLateralOffset ?? 0,
    )
    expect(edges.get('ingress')?.toPort.side).toBe('left')
    expect(edges.get('app')?.fromPort.side).toBe('right')
    expect(edges.get('db')?.fromPort.side).toBe('right')
  })
})
