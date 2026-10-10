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
})
