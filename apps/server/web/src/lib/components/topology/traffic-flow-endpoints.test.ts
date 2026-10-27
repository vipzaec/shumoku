import { describe, expect, it } from 'vitest'
import { resolveTrafficFlowEndpoints } from './traffic-flow-endpoints'

const graph = {
  nodes: [
    { id: 'discovered:0', metadata: { logicalId: 'internet' } },
    { id: 'resolved-firewall' },
    { id: 'resolved-service' },
    { id: 'vm-ulid' },
  ],
  links: [
    { id: 'wan', from: { node: 'discovered:0' }, to: { node: 'resolved-firewall' } },
    { id: 'policy', from: { node: 'resolved-firewall' }, to: { node: 'resolved-service' } },
    { id: 'target', from: { node: 'resolved-service' }, to: { node: 'vm-ulid' } },
  ],
}

describe('resolveTrafficFlowEndpoints', () => {
  it('finds a reconciled target through the explicit link IDs', () => {
    const flow = {
      source: 'internet',
      destination: 'target-172-16-15-15',
      primaryLinkIds: ['wan', 'policy', 'target'],
    }
    expect(resolveTrafficFlowEndpoints(flow, graph, 'discovered:0')).toMatchObject({
      source: 'discovered:0',
      destination: 'vm-ulid',
    })
  })

  it('uses logical IDs when available, even if the link list is incomplete', () => {
    const flow = { source: 'internet', destination: 'internet', primaryLinkIds: ['policy'] }
    expect(resolveTrafficFlowEndpoints(flow, graph)).toMatchObject({
      source: 'discovered:0',
      destination: 'discovered:0',
    })
  })

  it('preserves unresolved names when there is no evidence for a target', () => {
    const flow = { source: 'external', destination: 'unknown-vm' }
    expect(resolveTrafficFlowEndpoints(flow, graph, 'discovered:0')).toMatchObject({
      source: 'discovered:0',
      destination: 'unknown-vm',
    })
  })
})
