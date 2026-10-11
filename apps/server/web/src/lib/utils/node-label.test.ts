import { describe, expect, it } from 'vitest'
import { nodeLabel, nodeLabelById } from './node-label'

describe('nodeLabel', () => {
  it('uses a composed VM display name when its boundary node has no label', () => {
    const nodes = [
      {
        id: 'overview-vm-79-host',
        label: [],
        metadata: { displayName: 'admiral-sql.tetnet.net · 172.16.15.14' },
      },
    ]

    expect(nodeLabelById(nodes, 'overview-vm-79-host')).toBe(
      'admiral-sql.tetnet.net · 172.16.15.14',
    )
  })

  it('prefers the visible label and strips renderer markup from either source', () => {
    expect(nodeLabel({ id: 'vm', label: '<b>SQL</b>', metadata: { displayName: 'other' } })).toBe(
      'SQL',
    )
    expect(nodeLabel({ id: 'vm', label: [], metadata: { displayName: '<b>SQL</b>' } })).toBe('SQL')
  })
})
