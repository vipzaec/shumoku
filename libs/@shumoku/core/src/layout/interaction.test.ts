import { describe, expect, it } from 'vitest'
import type { Link, Node, Subgraph } from '../models/types.js'
import { isPortLinked, linkExists, rebalanceSubgraphs } from './interaction.js'
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
    expect(edges.get('app')?.fromLateralOffset).toBeUndefined()
    expect(edges.get('db')?.fromLateralOffset).toBeUndefined()
    expect(edges.get('ingress')?.toPort.side).toBe('left')
    expect(edges.get('app')?.fromPort.side).toBe('right')
    expect(edges.get('db')?.fromPort.side).toBe('right')
  })
})
