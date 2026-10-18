import { describe, expect, test } from 'vitest'
import type { NetworkGraph } from '../../models/types.js'
import { isBetterResult, searchCompositeLayout } from './search.js'

describe('composite layout choice', () => {
  test('prefers fewer line crossings over a shorter route', async () => {
    const graph: NetworkGraph = {
      version: '1.0',
      name: 'choice',
      nodes: [
        { id: 'a', label: 'A', shape: 'rect' },
        { id: 'b', label: 'B', shape: 'rect' },
      ],
      links: [{ id: 'a-b', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }],
    }
    const baseline = await searchCompositeLayout(graph, { maxEvaluations: 1 })
    const clear = {
      ...baseline,
      score: { ...baseline.score, crossings: 0, collinear: 0, cost: 300 },
    }
    const tangled = {
      ...baseline,
      score: { ...baseline.score, crossings: 1, collinear: 0, cost: 10 },
    }
    expect(isBetterResult(clear, tangled)).toBe(true)
    expect(isBetterResult(tangled, clear)).toBe(false)
    const clutteredClear = {
      ...clear,
      constraints: {
        ...clear.constraints,
        counts: { ...clear.constraints.counts, 'port-clutter': 1 },
      },
    }
    expect(isBetterResult(clutteredClear, tangled)).toBe(false)
  })
})
