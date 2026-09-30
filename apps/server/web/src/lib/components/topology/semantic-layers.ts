import type { NetworkGraph } from '@shumoku/core'

function tags(metadata: unknown, key: 'layer' | 'layers'): string[] {
  if (!metadata || typeof metadata !== 'object') return []
  const value = (metadata as Record<string, unknown>)[key]
  if (typeof value === 'string') return value ? [value] : []
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

export function semanticLayers(graph: NetworkGraph | undefined): string[] {
  if (!graph) return []
  return [
    ...new Set([
      ...graph.nodes.flatMap((node) => tags(node.metadata, 'layers')),
      ...graph.links.flatMap((link) => tags(link.metadata, 'layer')),
    ]),
  ].sort((a, b) => a.localeCompare(b))
}

export function semanticVisibility(
  graph: NetworkGraph,
  hiddenLayers: ReadonlySet<string>,
  forcedLinkIds: ReadonlySet<string> = new Set(),
): { hiddenNodeIds: Set<string>; hiddenLinkIds: Set<string> } {
  const hiddenLinkIds = new Set<string>()
  const connectedToVisibleLink = new Set<string>()
  for (const link of graph.links) {
    const layers = tags(link.metadata, 'layer')
    if (
      layers.length > 0 &&
      layers.every((layer) => hiddenLayers.has(layer)) &&
      !forcedLinkIds.has(link.id)
    ) {
      hiddenLinkIds.add(link.id)
    } else {
      connectedToVisibleLink.add(link.from.node)
      connectedToVisibleLink.add(link.to.node)
    }
  }
  const hiddenNodeIds = new Set(
    graph.nodes
      .filter((node) => {
        const layers = tags(node.metadata, 'layers')
        return (
          layers.length > 0 &&
          layers.every((layer) => hiddenLayers.has(layer)) &&
          !connectedToVisibleLink.has(node.id)
        )
      })
      .map((node) => node.id),
  )
  return { hiddenNodeIds, hiddenLinkIds }
}
