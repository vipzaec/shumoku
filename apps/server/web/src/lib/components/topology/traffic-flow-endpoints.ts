type FlowEndpoints = {
  source: string
  destination: string
  primaryLinkIds?: string[]
}

export type EndpointGraph = {
  nodes: Array<{ id: string; metadata?: Record<string, unknown> }>
  links: Array<{ id: string; from: { node: string }; to: { node: string } }>
}

/** Resolve generated flow endpoints after the server reconciles source node IDs. */
export function resolveTrafficFlowEndpoints<T extends FlowEndpoints>(
  flow: T,
  graph: EndpointGraph,
  containingNodeId?: string,
): T {
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  const byLogicalId = new Map(
    graph.nodes.flatMap((node) => {
      const logicalId = node.metadata?.['logicalId']
      return typeof logicalId === 'string' && logicalId ? [[logicalId, node.id] as const] : []
    }),
  )
  const linksById = new Map(graph.links.map((link) => [link.id, link]))
  const routeLinks = (flow.primaryLinkIds ?? [])
    .map((id) => linksById.get(id))
    .filter((link) => link !== undefined)
  const source =
    byLogicalId.get(flow.source) ??
    (nodeIds.has(flow.source) ? flow.source : undefined) ??
    containingNodeId ??
    routeLinks[0]?.from.node ??
    flow.source
  const destination =
    byLogicalId.get(flow.destination) ??
    (nodeIds.has(flow.destination) ? flow.destination : undefined) ??
    routeLinks.at(-1)?.to.node ??
    flow.destination
  return { ...flow, source, destination }
}
