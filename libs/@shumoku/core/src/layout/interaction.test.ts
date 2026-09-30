import { describe, expect, it } from 'vitest'
import type { Link, Node, Subgraph } from '../models/types.js'
import { isPortLinked, linkExists, rebalanceSubgraphs } from './interaction.js'

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
