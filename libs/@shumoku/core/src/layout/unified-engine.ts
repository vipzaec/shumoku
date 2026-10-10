// Copyright (C) 2026-present Akitoshi Saeki
// SPDX-License-Identifier: AGPL-3.0-only
// For commercial licensing, contact: contact@shumoku.dev

/**
 * Unified layout engine adapter
 *
 * Wraps the engine-driven `autoLayoutFlatTree` plus the trivial
 * `routeEdges` pass that attaches port-anchored `ResolvedEdge`
 * records. Edge geometry is computed in the renderer as cubic
 * Beziers from the port positions, so no routing solver is
 * involved at this layer anymore.
 *
 * Used by server, CLI, renderer-html, and renderer-svg for
 * consistent layout. The `LayoutEngine` interface here is the
 * legacy async wrapper from `hierarchical.ts`; the underlying
 * spatial-rule engine (`@shumoku/core/layout/engine`) is
 * instantiated inside `computeNetworkLayout`.
 */

import type { LayoutEngine } from '../hierarchical.js'
import type { LayoutResult, NetworkGraph, Node, Subgraph } from '../models/types.js'
import { autoLayoutFlatTree } from './auto-placement/flat-tree/auto-layout.js'
import { layoutCompound } from './auto-placement/flat-tree/compound.js'
import { shouldUseComposite } from './composite/index.js'
import { searchCompositeLayout } from './composite/search.js'
import { assertLayoutConstraints } from './constraints.js'
import { createEngine, resolveNodeSize } from './engine/index.js'
import { getLinkWidth } from './link-utils.js'
import type { ResolvedLayout, ResolvedPort } from './resolved-types.js'
import { routeEdges } from './route-edges.js'

/** Keep an operator-sized container large enough to contain its layout children. */
function applyOperatorGroupBounds(
  graph: NetworkGraph,
  nodes: Map<string, Node>,
  ports: Map<string, ResolvedPort>,
  subgraphs: Map<string, Subgraph>,
): void {
  const sources = new Map((graph.subgraphs ?? []).map((group) => [group.id, group]))
  const depth = (group: Subgraph): number => {
    let result = 0
    let parent = group.parent
    const seen = new Set<string>()
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      result++
      parent = sources.get(parent)?.parent
    }
    return result
  }
  for (const group of [...subgraphs.values()].sort((a, b) => depth(b) - depth(a))) {
    const original = sources.get(group.id)
    const requested = original?.metadata?.['operatorBounds']
    const current = group.bounds
    const valid =
      requested &&
      typeof requested === 'object' &&
      'x' in requested &&
      'y' in requested &&
      'width' in requested &&
      'height' in requested &&
      typeof requested.x === 'number' &&
      typeof requested.y === 'number' &&
      typeof requested.width === 'number' &&
      typeof requested.height === 'number' &&
      Number.isFinite(requested.x) &&
      Number.isFinite(requested.y) &&
      Number.isFinite(requested.width) &&
      Number.isFinite(requested.height)
    if (!current && !valid) continue
    const childBounds = [...subgraphs.values()]
      .filter((child) => child.parent === group.id && child.bounds)
      .map(
        (child) =>
          child.bounds && {
            x: child.bounds.x - 20,
            y: child.bounds.y - 48,
            width: child.bounds.width + 40,
            height: child.bounds.height + 68,
          },
      )
    const boxes = [current, ...(valid ? [requested] : []), ...childBounds].filter(
      (box): box is { x: number; y: number; width: number; height: number } =>
        Boolean(box) &&
        typeof box?.x === 'number' &&
        typeof box?.y === 'number' &&
        typeof box?.width === 'number' &&
        typeof box?.height === 'number',
    )
    if (boxes.length === 0) continue
    const x = Math.min(...boxes.map((box) => box.x))
    const y = Math.min(...boxes.map((box) => box.y))
    const right = Math.max(...boxes.map((box) => box.x + box.width))
    const bottom = Math.max(...boxes.map((box) => box.y + box.height))
    subgraphs.set(group.id, { ...group, bounds: { x, y, width: right - x, height: bottom - y } })
  }
  // Boundary interfaces are physical points on the container contour. The
  // default layout seated them before the operator's larger bounds were applied.
  for (const [nodeId, node] of nodes) {
    if (node.metadata?.['presentationRole'] !== 'subgraph-boundary-port' || !node.parent) continue
    const bounds = subgraphs.get(node.parent)?.bounds
    if (!bounds) continue
    let firstPoint: { x: number; y: number } | undefined
    for (const [portId, port] of ports) {
      if (port.nodeId !== nodeId) continue
      const modelPort = node.ports?.find((candidate) => `${nodeId}:${candidate.id}` === portId)
      const side = modelPort?.placement?.side ?? port.side
      const offset = Math.max(0.08, Math.min(0.92, modelPort?.placement?.offset ?? 0.5))
      const point = {
        x:
          side === 'left'
            ? bounds.x
            : side === 'right'
              ? bounds.x + bounds.width
              : bounds.x + bounds.width * offset,
        y:
          side === 'top'
            ? bounds.y
            : side === 'bottom'
              ? bounds.y + bounds.height
              : bounds.y + bounds.height * offset,
      }
      firstPoint ??= point
      ports.set(portId, { ...port, side, absolutePosition: point })
    }
    if (firstPoint) nodes.set(nodeId, { ...node, position: firstPoint })
  }
}

function includeGroupBounds(
  bounds: { x: number; y: number; width: number; height: number },
  subgraphs: ReadonlyMap<string, Subgraph>,
) {
  let x = bounds.x
  let y = bounds.y
  let right = bounds.x + bounds.width
  let bottom = bounds.y + bounds.height
  for (const group of subgraphs.values()) {
    if (!group.bounds) continue
    x = Math.min(x, group.bounds.x)
    y = Math.min(y, group.bounds.y)
    right = Math.max(right, group.bounds.x + group.bounds.width)
    bottom = Math.max(bottom, group.bounds.y + group.bounds.height)
  }
  return { x, y, width: right - x, height: bottom - y }
}

/**
 * Create a LayoutEngine that uses the custom network layout + libavoid routing.
 * Returns LayoutResult for backward compatibility with existing consumers.
 */
export function createNetworkLayoutEngine(): LayoutEngine {
  return {
    async layoutAsync(graph: NetworkGraph): Promise<LayoutResult> {
      const { layout } = await computeNetworkLayout(graph)
      return layout
    },
    async layoutWithResolved(graph: NetworkGraph) {
      return computeNetworkLayout(graph)
    },
  }
}

/**
 * Compute layout and return both ResolvedLayout and legacy LayoutResult.
 * Use this when you need both (e.g., renderer-svg uses ResolvedLayout directly).
 */
export async function computeNetworkLayout(
  graph: NetworkGraph,
  options: { compound?: boolean; composite?: boolean } = {},
): Promise<{
  resolved: ResolvedLayout
  layout: LayoutResult
}> {
  const direction = graph.settings?.direction ?? 'TB'
  const fixed = new Set(graph.nodes.filter((node) => node.position).map((node) => node.id))

  // Composite zone layout (v3 engine, #429): zones from location
  // metadata, layered quotient placement, octilinear edge routing.
  // Explicit option wins; otherwise auto-enable for graphs with broad
  // zone metadata (discovered networks), where it reads far better than
  // flat-tree/compound. Hand-drawn diagrams rarely qualify.
  const useComposite = options.composite ?? (fixed.size === 0 && shouldUseComposite(graph))
  if (useComposite) {
    // Place-and-route search (v3 突き合わせ loop): placement variants are
    // routed for real and the routed-geometry score arbitrates — gaps
    // multi-start, congestion-widened channels, redundant-pair flips.
    const { comp, ports, edges } = await searchCompositeLayout(graph)
    applyOperatorGroupBounds(graph, comp.nodes, ports, comp.subgraphs)
    if ((graph.subgraphs ?? []).some((group) => group.metadata?.['operatorBounds'])) {
      const rerouted = await routeEdges(comp.nodes, ports, graph.links, comp.subgraphs)
      edges.clear()
      for (const [id, edge] of rerouted) edges.set(id, edge)
    }
    // primary dependency tree emphasis for renderers
    for (const edge of edges.values()) {
      const key =
        edge.fromNodeId < edge.toNodeId
          ? `${edge.fromNodeId}|${edge.toNodeId}`
          : `${edge.toNodeId}|${edge.fromNodeId}`
      edge.emphasis = comp.primaryEdges.has(key) ? 'primary' : 'secondary'
    }
    const results = buildResults({
      nodes: comp.nodes,
      ports,
      edges,
      subgraphs: comp.subgraphs,
      bounds: includeGroupBounds(comp.bounds, comp.subgraphs),
      algorithm: 'composite+octilinear',
    })
    // Standing fixture (#482): BLOCKING constraint violations throw in
    // dev/test, log in production — never silently ship a broken figure.
    assertLayoutConstraints(results.resolved, 'composite+octilinear')
    return results
  }

  // Create a spatial-rule engine once per layout call. Engines
  // are stateless beyond memoization, so this is cheap; in
  // contexts that lay out repeatedly (drag, animation) the
  // engine instance can be hoisted to caller scope.
  const engine = createEngine()
  // `compound` folds each subgraph into a compact box and arranges
  // the boxes by dependency — the container reading that scales to
  // large grouped (auto-discovered) graphs.
  // Link width is bandwidth-derived and can be tens of px on a fast
  // fabric. The flat-tree gaps are otherwise fixed, so a thick pipe
  // overruns the nodes it runs between. Widen the sibling/layer gaps to
  // clear the thickest link so the wiring has room (thin-link graphs
  // keep the small defaults).
  let maxLinkWidth = 0
  for (const l of graph.links) maxLinkWidth = Math.max(maxLinkWidth, getLinkWidth(l))
  const nodeGap = Math.max(30, Math.round(maxLinkWidth) + 16)
  const layerGap = Math.max(80, Math.round(maxLinkWidth) + 24)

  const layoutFn = options.compound && fixed.size === 0 ? layoutCompound : autoLayoutFlatTree
  const { nodes, ports, subgraphs, bounds } = layoutFn(graph, engine, {
    direction,
    nodeGap,
    layerGap,
    subgraphPadding: graph.settings?.subgraphPadding,
    fixed,
  })
  applyOperatorGroupBounds(graph, nodes, ports, subgraphs)
  const edges = await routeEdges(nodes, ports, graph.links, subgraphs)

  const results = buildResults({
    nodes,
    ports,
    edges,
    subgraphs,
    bounds: includeGroupBounds(bounds, subgraphs),
    algorithm: 'network-layout+bezier',
  })
  assertLayoutConstraints(results.resolved, 'network-layout+bezier')
  return results
}

/** Assemble ResolvedLayout + legacy LayoutResult from layout pieces. */
function buildResults(input: {
  nodes: ResolvedLayout['nodes']
  ports: ResolvedLayout['ports']
  edges: ResolvedLayout['edges']
  subgraphs: ResolvedLayout['subgraphs']
  bounds: ResolvedLayout['bounds']
  algorithm: string
}): { resolved: ResolvedLayout; layout: LayoutResult } {
  const { nodes, ports, edges, subgraphs, bounds } = input
  const resolved: ResolvedLayout = {
    nodes,
    ports,
    edges,
    subgraphs,
    bounds,
    metadata: { algorithm: input.algorithm, duration: 0 },
  }

  // Build LayoutResult with ports converted from absolute to center-relative
  const layoutNodes = new Map(
    [...nodes].map(([id, node]) => {
      // Collect ports for this node, convert absolute → center-relative
      const nodePorts = new Map<
        string,
        {
          id: string
          label: string
          position: { x: number; y: number }
          size: { width: number; height: number }
          side: 'top' | 'bottom' | 'left' | 'right'
        }
      >()
      const pos = node.position ?? { x: 0, y: 0 }
      const size = resolveNodeSize(node)
      for (const [portId, rp] of ports) {
        if (rp.nodeId !== id) continue
        nodePorts.set(portId, {
          id: portId,
          label: rp.label,
          position: {
            x: rp.absolutePosition.x - pos.x,
            y: rp.absolutePosition.y - pos.y,
          },
          size: rp.size,
          side: rp.side,
        })
      }
      return [
        id,
        {
          id,
          position: pos,
          size,
          node,
          ...(nodePorts.size > 0 ? { ports: nodePorts } : {}),
        },
      ] as const
    }),
  )

  const layout: LayoutResult = {
    nodes: layoutNodes,
    links: new Map(
      [...edges].map(([id, re]) => [
        id,
        {
          id,
          from: re.fromNodeId,
          to: re.toNodeId,
          fromEndpoint: re.fromEndpoint,
          toEndpoint: re.toEndpoint,
          points: re.points,
          link: re.link,
        },
      ]),
    ),
    subgraphs: new Map(
      [...subgraphs].map(([id, sg]) => [
        id,
        { id, bounds: sg.bounds ?? { x: 0, y: 0, width: 0, height: 0 }, subgraph: sg },
      ]),
    ),
    bounds,
    metadata: resolved.metadata,
  }

  return { resolved, layout }
}
