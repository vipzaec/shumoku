import {
  DeviceType,
  darkTheme,
  type Node,
  type ResolvedLayout,
  type ResolvedPort,
  type Subgraph,
} from '@shumoku/core'
import { describe, expect, it } from 'vitest'
import { renderSvgString } from './static.js'

describe('renderSvgString', () => {
  it('draws a shared boundary port without an inner LAN card', () => {
    const boundary: Node = {
      id: 'vm-lan',
      label: [],
      parent: 'vm',
      position: { x: 10, y: 70 },
      metadata: { presentationRole: 'subgraph-boundary-port' },
      ports: [{ id: 'lan', label: 'LAN', connectors: [] }],
    }
    const port: ResolvedPort = {
      id: 'vm-lan:lan',
      nodeId: boundary.id,
      label: 'LAN',
      side: 'left',
      absolutePosition: { x: 10, y: 70 },
      size: { width: 8, height: 8 },
    }
    const layout: ResolvedLayout = {
      nodes: new Map([[boundary.id, boundary]]),
      ports: new Map([[port.id, port]]),
      edges: new Map(),
      subgraphs: new Map([
        ['vm', { id: 'vm', label: 'VM', bounds: { x: 10, y: 0, width: 200, height: 140 } }],
      ]),
      bounds: { x: 0, y: 0, width: 220, height: 150 },
    }
    const svg = renderSvgString(layout)
    expect(svg).toContain('data-port="vm-lan:lan"')
    expect(svg).not.toContain('data-id="vm-lan"')
  })

  it('draws group titles above nodes with a background halo', () => {
    const group: Subgraph = {
      id: 'group',
      label: 'Group title',
      bounds: { x: 0, y: 0, width: 220, height: 140 },
    }
    const node: Node = {
      id: 'node',
      label: 'Node',
      parent: group.id,
      position: { x: 100, y: 80 },
      size: { width: 80, height: 50 },
    }
    const layout: ResolvedLayout = {
      nodes: new Map([[node.id, node]]),
      ports: new Map(),
      edges: new Map(),
      subgraphs: new Map([[group.id, group]]),
      bounds: { x: 0, y: 0, width: 220, height: 140 },
    }
    const svg = renderSvgString(layout)
    expect(svg.indexOf('<g class="subgraph"')).toBeLessThan(svg.indexOf('<g class="node"'))
    expect(svg.indexOf('<g class="node"')).toBeLessThan(svg.indexOf('class="subgraph-label"'))
    expect(svg).toContain('paint-order="stroke fill"')
  })

  it('renders a legacy resolved port whose label is missing', () => {
    const port: ResolvedPort = {
      id: 'node:legacy-port',
      nodeId: 'node',
      label: undefined as unknown as string,
      absolutePosition: { x: 10, y: 10 },
      side: 'top',
      size: { width: 8, height: 8 },
    }
    const layout: ResolvedLayout = {
      nodes: new Map(),
      ports: new Map([[port.id, port]]),
      edges: new Map(),
      subgraphs: new Map(),
      bounds: { x: 0, y: 0, width: 20, height: 20 },
      metadata: { algorithm: 'test', duration: 0 },
    }

    expect(renderSvgString(layout)).toContain('data-port="node:legacy-port"')
  })

  it.each([
    ['URL', 'https://example.com/device.svg', '<image href="https://example.com/device.svg"'],
    ['inline', '<path d="M1 1h22v22H1z"/>', '<path d="M1 1h22v22H1z"/>'],
  ])('uses the resolved %s icon just like the interactive renderer', (_kind, icon, expected) => {
    const node: Node = {
      id: 'router',
      label: 'Router',
      position: { x: 50, y: 50 },
      size: { width: 100, height: 80 },
      spec: { kind: 'hardware', type: DeviceType.Router, icon },
    }
    const layout: ResolvedLayout = {
      nodes: new Map([[node.id, node]]),
      ports: new Map(),
      edges: new Map(),
      subgraphs: new Map(),
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    }

    const svg = renderSvgString(layout)
    expect(svg).toContain(expected)
    expect(svg).toContain('data-device-type="router"')
  })

  it('applies the requested theme to static output', () => {
    const layout: ResolvedLayout = {
      nodes: new Map(),
      ports: new Map(),
      edges: new Map(),
      subgraphs: new Map(),
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    }

    expect(renderSvgString(layout, { theme: darkTheme })).toContain(darkTheme.colors.textSecondary)
  })
})
