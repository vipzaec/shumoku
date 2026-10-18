import { describe, expect, test } from 'vitest'
import type { NetworkGraph, Node } from '../models/types.js'
import { searchCompositeLayout } from './composite/search.js'
import { computeNetworkLayout } from './unified-engine.js'

const node = (id: string, parent?: string): Node => ({
  id,
  label: id,
  shape: 'rect',
  ...(parent ? { parent } : {}),
})

const link = (from: string, to: string) => ({
  id: `${from}-${to}`,
  from: { node: from, port: 'out' },
  to: { node: to, port: 'in' },
})

describe('authored spacing survives automatic layout', () => {
  test('spacing settings do not inflate a fully positioned nested plan', async () => {
    const base: NetworkGraph = {
      version: '1.0',
      name: 'placed services',
      nodes: [
        { ...node('service-a', 'vm-a'), position: { x: 100, y: 100 } },
        { ...node('service-b', 'vm-b'), position: { x: 500, y: 100 } },
      ],
      links: [link('service-a', 'service-b')],
      subgraphs: [
        { id: 'vm-a', label: 'VM A' },
        { id: 'vm-b', label: 'VM B' },
      ],
      settings: { direction: 'LR' },
    }
    const normal = await computeNetworkLayout(base, { composite: false })
    const spaced = await computeNetworkLayout(
      {
        ...base,
        settings: { direction: 'LR', nodeSpacing: 220, rankSpacing: 410, subgraphPadding: 112 },
      },
      { composite: false },
    )
    expect(spaced.resolved.nodes.get('service-a')?.position).toEqual({ x: 100, y: 100 })
    expect(spaced.resolved.nodes.get('service-b')?.position).toEqual({ x: 500, y: 100 })
    expect(spaced.resolved.subgraphs.get('vm-a')?.bounds).toEqual(
      normal.resolved.subgraphs.get('vm-a')?.bounds,
    )
    expect(spaced.resolved.subgraphs.get('vm-b')?.bounds).toEqual(
      normal.resolved.subgraphs.get('vm-b')?.bounds,
    )
  })

  test('flat-tree honours the plan rank gap after a reset', async () => {
    const base: NetworkGraph = {
      version: '1.0',
      name: 'chain',
      nodes: [node('source'), node('target')],
      links: [link('source', 'target')],
      settings: { direction: 'LR' },
    }
    const normal = await computeNetworkLayout(base, { composite: false })
    const spaced = await computeNetworkLayout(
      { ...base, settings: { direction: 'LR', rankSpacing: 410 } },
      { composite: false },
    )
    const distance = (layout: typeof normal) =>
      Math.abs(
        (layout.resolved.nodes.get('target')?.position?.x ?? 0) -
          (layout.resolved.nodes.get('source')?.position?.x ?? 0),
      )
    expect(distance(spaced)).toBeGreaterThan(distance(normal) + 250)
  })

  test('flat-tree gives sibling blocks the requested horizontal clearance', async () => {
    const base: NetworkGraph = {
      version: '1.0',
      name: 'fan',
      nodes: [node('hub'), node('left'), node('right')],
      links: [link('hub', 'left'), link('hub', 'right')],
      settings: { direction: 'TB' },
    }
    const normal = await computeNetworkLayout(base, { composite: false })
    const spaced = await computeNetworkLayout(
      { ...base, settings: { direction: 'TB', nodeSpacing: 220 } },
      { composite: false },
    )
    const distance = (layout: typeof normal) =>
      Math.abs(
        (layout.resolved.nodes.get('right')?.position?.x ?? 0) -
          (layout.resolved.nodes.get('left')?.position?.x ?? 0),
      )
    expect(distance(spaced)).toBeGreaterThan(distance(normal) + 150)
  })

  test('composite search cannot compact a plan below its authored gaps', async () => {
    const base: NetworkGraph = {
      version: '1.0',
      name: 'two groups',
      nodes: [node('a', 'a-group'), node('b', 'b-group')],
      links: [link('a', 'b')],
      subgraphs: [
        { id: 'a-group', label: 'A' },
        { id: 'b-group', label: 'B' },
      ],
      settings: { direction: 'LR' },
    }
    const normal = await searchCompositeLayout(base, { maxEvaluations: 12 })
    const spaced = await searchCompositeLayout(
      { ...base, settings: { direction: 'LR', nodeSpacing: 220, rankSpacing: 410 } },
      { maxEvaluations: 12 },
    )
    const distance = (result: typeof normal) =>
      Math.hypot(
        (result.comp.nodes.get('b')?.position?.x ?? 0) -
          (result.comp.nodes.get('a')?.position?.x ?? 0),
        (result.comp.nodes.get('b')?.position?.y ?? 0) -
          (result.comp.nodes.get('a')?.position?.y ?? 0),
      )
    expect(distance(spaced)).toBeGreaterThan(distance(normal) + 150)
  })
})
