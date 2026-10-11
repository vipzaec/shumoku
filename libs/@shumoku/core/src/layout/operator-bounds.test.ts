import { describe, expect, it } from 'vitest'
import type { NetworkGraph } from '../models/types.js'
import { computeNetworkLayout } from './unified-engine.js'

describe('operator-sized blocks', () => {
  it('keeps an enlarged container around its child and includes it in the canvas', async () => {
    const graph: NetworkGraph = {
      version: '1',
      name: 'editable group',
      nodes: [
        {
          id: 'service',
          label: 'Service',
          parent: 'vm',
          position: { x: 200, y: 200 },
          size: { width: 100, height: 60 },
        },
        {
          id: 'vm-interface',
          label: '',
          parent: 'vm',
          position: { x: 200, y: 200 },
          metadata: { presentationRole: 'subgraph-boundary-port' },
          ports: [
            { id: 'lan', label: 'LAN', connectors: [], placement: { side: 'left', offset: 0.5 } },
          ],
        },
      ],
      links: [],
      subgraphs: [
        {
          id: 'vm',
          label: 'VM',
          metadata: { operatorBounds: { x: 30, y: 30, width: 400, height: 300 } },
        },
      ],
    }
    const { resolved } = await computeNetworkLayout(graph)
    const bounds = resolved.subgraphs.get('vm')?.bounds
    expect(bounds).toBeDefined()
    expect(bounds?.x).toBeLessThanOrEqual(30)
    expect(bounds?.y).toBeLessThanOrEqual(30)
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeGreaterThanOrEqual(430)
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeGreaterThanOrEqual(330)
    expect(resolved.bounds.x).toBeLessThanOrEqual(bounds?.x ?? 0)
    expect(resolved.bounds.x + resolved.bounds.width).toBeGreaterThanOrEqual(
      (bounds?.x ?? 0) + (bounds?.width ?? 0),
    )
    expect(resolved.ports.get('vm-interface:lan')?.absolutePosition.x).toBe(bounds?.x)
    expect(resolved.nodes.get('vm-interface')?.position?.x).toBe(bounds?.x)
  })

  it('shrinks an operator container without clipping its children or stranding its interface', async () => {
    const graph: NetworkGraph = {
      version: '1',
      name: 'resizable group',
      nodes: [
        {
          id: 'service',
          label: 'Service',
          parent: 'vm',
          position: { x: 200, y: 200 },
          size: { width: 100, height: 60 },
        },
        {
          id: 'vm-interface',
          label: '',
          parent: 'vm',
          position: { x: 200, y: 200 },
          metadata: { presentationRole: 'subgraph-boundary-port' },
          ports: [
            { id: 'lan', label: 'LAN', connectors: [], placement: { side: 'left', offset: 0.5 } },
          ],
        },
      ],
      links: [],
      subgraphs: [
        {
          id: 'vm',
          label: 'VM',
          metadata: { operatorBounds: { x: 80, y: 70, width: 400, height: 300 } },
        },
      ],
    }
    const large = (await computeNetworkLayout(graph)).resolved.subgraphs.get('vm')?.bounds
    expect(large?.width).toBeGreaterThanOrEqual(400)

    if (!graph.subgraphs?.[0]) throw new Error('missing VM group')
    graph.subgraphs[0].metadata = {
      operatorBounds: { x: 120, y: 120, width: 160, height: 170 },
    }
    const { resolved } = await computeNetworkLayout(graph)
    const small = resolved.subgraphs.get('vm')?.bounds
    expect(small).toEqual({ x: 120, y: 120, width: 160, height: 170 })
    expect(small?.width ?? Infinity).toBeLessThan(large?.width ?? 0)
    expect(resolved.ports.get('vm-interface:lan')?.absolutePosition.x).toBe(120)

    graph.subgraphs[0].metadata = {
      operatorBounds: { x: 190, y: 190, width: 40, height: 30 },
    }
    const constrained = (await computeNetworkLayout(graph)).resolved.subgraphs.get('vm')?.bounds
    expect(constrained?.x).toBeLessThanOrEqual(130)
    expect(constrained?.y).toBeLessThanOrEqual(122)
    expect((constrained?.x ?? 0) + (constrained?.width ?? 0)).toBeGreaterThanOrEqual(270)
    expect((constrained?.y ?? 0) + (constrained?.height ?? 0)).toBeGreaterThanOrEqual(250)
  })
})
