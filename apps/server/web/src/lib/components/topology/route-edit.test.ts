import type { ResolvedEdge, ResolvedLayout } from '@shumoku/core'
import { describe, expect, it } from 'vitest'
import {
  editableRouteBends,
  nonEmptyRouteOverrides,
  preserveAutomaticRoutes,
  removeEditableRouteBend,
} from './route-edit'

const route = {
  kind: 'polyline' as const,
  points: [
    { x: 0, y: 0 },
    { x: 40, y: -20 },
    { x: 80, y: -20 },
    { x: 120, y: 0 },
  ],
}

describe('manual route editing', () => {
  it('keeps existing automatic bends when the first new point is added', () => {
    const bends = editableRouteBends(undefined, route)
    bends.splice(1, 0, { x: 60, y: -40 })
    expect(bends).toEqual([
      { x: 40, y: -20 },
      { x: 60, y: -40 },
      { x: 80, y: -20 },
    ])
    expect(route.points).toHaveLength(4)
  })

  it('honors an explicitly cleared manual route instead of restoring automatic bends', () => {
    expect(editableRouteBends([], route)).toEqual([])
  })

  it('restores automatic routing when the final hand-drawn bend is removed', () => {
    expect(removeEditableRouteBend([{ x: 60, y: -40 }], 0)).toBeNull()
    expect(
      removeEditableRouteBend(
        [
          { x: 40, y: -20 },
          { x: 60, y: -40 },
        ],
        0,
      ),
    ).toEqual([{ x: 60, y: -40 }])
  })

  it('ignores old empty route overrides when loading a saved layout', () => {
    expect(nonEmptyRouteOverrides({ cleared: [], handDrawn: [{ x: 60, y: -40 }] })).toEqual({
      handDrawn: [{ x: 60, y: -40 }],
    })
  })

  it('keeps moved endpoints but discards a temporary manual route from the captured base', () => {
    const edge = (start: number, handDrawn: boolean) =>
      ({
        fromPort: { absolutePosition: { x: start, y: 0 } },
        toPort: { absolutePosition: { x: 120, y: 0 } },
        points: [
          { x: start, y: 0 },
          { x: 120, y: 0 },
        ],
        ...(handDrawn
          ? {
              route: {
                kind: 'polyline',
                points: [
                  { x: start, y: 0 },
                  { x: 60, y: -40 },
                  { x: 120, y: 0 },
                ],
              },
            }
          : {}),
      }) as ResolvedEdge
    const layout = (e: ResolvedEdge, x: number) =>
      ({
        nodes: new Map([['node', { id: 'node', position: { x, y: 0 } }]]),
        edges: new Map([['link', e]]),
        ports: new Map(),
        subgraphs: new Map(),
        bounds: { x: 0, y: 0, width: 200, height: 100 },
      }) as ResolvedLayout
    const base = layout(edge(0, false), 0)
    const current = layout(edge(20, true), 20)

    const captured = preserveAutomaticRoutes(current, base, { link: [{ x: 60, y: -40 }] })
    expect(captured.nodes.get('node')?.position?.x).toBe(20)
    expect(captured.edges.get('link')?.route).toBeUndefined()
    expect(captured.edges.get('link')?.points).toEqual([
      { x: 20, y: 0 },
      { x: 120, y: 0 },
    ])
    expect(current.edges.get('link')?.route).toBeDefined()
  })

  it('updates endpoints of an automatic polyline when capturing moved nodes', () => {
    const endpoint = (x: number) => ({ absolutePosition: { x, y: 0 } })
    const baseEdge = {
      fromPort: endpoint(0),
      toPort: endpoint(120),
      route,
      points: route.points,
    } as ResolvedEdge
    const currentEdge = {
      ...baseEdge,
      fromPort: endpoint(20),
      route: {
        kind: 'polyline',
        points: [
          { x: 20, y: 0 },
          { x: 60, y: -40 },
          { x: 120, y: 0 },
        ],
      },
    } as ResolvedEdge
    const layout = (edge: ResolvedEdge) =>
      ({
        edges: new Map([['link', edge]]),
        nodes: new Map(),
        ports: new Map(),
        subgraphs: new Map(),
        bounds: { x: 0, y: 0, width: 200, height: 100 },
      }) as ResolvedLayout

    const captured = preserveAutomaticRoutes(layout(currentEdge), layout(baseEdge), {
      link: [{ x: 60, y: -40 }],
    })
    expect(captured.edges.get('link')?.route?.points).toEqual([
      { x: 20, y: 0 },
      { x: 40, y: -20 },
      { x: 80, y: -20 },
      { x: 120, y: 0 },
    ])
  })
})
