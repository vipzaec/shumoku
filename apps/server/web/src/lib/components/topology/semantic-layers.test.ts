import type { NetworkGraph } from '@shumoku/core'
import { describe, expect, it } from 'vitest'
import { semanticLayers, semanticVisibility } from './semantic-layers'

const graph = {
  name: 'Layer example',
  nodes: [
    { id: 'gateway' },
    { id: 'vm', metadata: { layers: ['Compute'] } },
    { id: 'service', metadata: { layers: ['Publications', 'Compute'] } },
    { id: 'dns', metadata: { layers: ['DNS'] } },
  ],
  links: [
    { id: 'lan', from: { node: 'gateway' }, to: { node: 'vm' }, metadata: { layer: 'Network' } },
    {
      id: 'web',
      from: { node: 'vm' },
      to: { node: 'service' },
      metadata: { layer: 'Publications' },
    },
    { id: 'dns', from: { node: 'gateway' }, to: { node: 'dns' }, metadata: { layer: 'DNS' } },
  ],
} as NetworkGraph

describe('semantic layers', () => {
  it('discovers relationship names from nodes and links', () => {
    expect(semanticLayers(graph)).toEqual(['Compute', 'DNS', 'Network', 'Publications'])
  })

  it('hides a relationship without moving or deleting shared infrastructure nodes', () => {
    const visibility = semanticVisibility(graph, new Set(['DNS', 'Publications']))
    expect([...visibility.hiddenLinkIds].sort()).toEqual(['dns', 'web'])
    expect([...visibility.hiddenNodeIds]).toEqual(['dns'])
  })

  it('shows a selected flow even when its layer is hidden', () => {
    const visibility = semanticVisibility(graph, new Set(['DNS']), new Set(['dns']))
    expect(visibility.hiddenLinkIds.size).toBe(0)
    expect(visibility.hiddenNodeIds.size).toBe(0)
  })
})
