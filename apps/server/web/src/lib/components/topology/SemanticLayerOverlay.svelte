<script lang="ts">
  import type { NetworkGraph } from '@shumoku/core'
  import { semanticVisibility } from './semantic-layers'

  let {
    svgElement,
    graph,
    hiddenLayers,
    forcedLinkIds = new Set(),
  }: {
    svgElement: SVGSVGElement | null
    graph: NetworkGraph
    hiddenLayers: ReadonlySet<string>
    forcedLinkIds?: ReadonlySet<string>
  } = $props()

  $effect(() => {
    if (!svgElement) return
    const { hiddenNodeIds, hiddenLinkIds } = semanticVisibility(graph, hiddenLayers, forcedLinkIds)
    const changed: SVGElement[] = []
    for (const node of svgElement.querySelectorAll<SVGElement>('g.node[data-id]')) {
      if (hiddenNodeIds.has(node.getAttribute('data-id') ?? '')) {
        node.style.display = 'none'
        changed.push(node)
      }
    }
    for (const link of svgElement.querySelectorAll<SVGElement>('g.link-group[data-link-id]')) {
      if (hiddenLinkIds.has(link.getAttribute('data-link-id') ?? '')) {
        link.style.display = 'none'
        changed.push(link)
      }
    }
    return () => {
      for (const element of changed) element.style.removeProperty('display')
    }
  })
</script>
