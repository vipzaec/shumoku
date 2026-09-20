<script lang="ts" module>
  // Event types for node selection (exported from module context)
  export interface NodeInfo {
    id: string
    label: string
    labels?: string[]
    parent?: string
    metadata?: Record<string, unknown>
    ports?: Array<{
      id: string
      label?: string
      side?: 'top' | 'bottom' | 'left' | 'right'
    }>
    spec?: {
      type?: string
      vendor?: string
      model?: string
    }
    /** Observation-model provenance / state, stamped by the server's
     *  resolver. Optional — undefined for graphs that pre-date the model. */
    provenance?: {
      source: string
      state?: 'confirmed' | 'intrinsic-only' | 'discovered-only' | 'conflicting'
      observedAt?: number
    }
    /** Identity keys used by the resolver to match this node across
     *  sources / re-scans. */
    identity?: {
      mgmtIp?: string
      chassisId?: string
      sysName?: string
      ifIndex?: number
      ifName?: string
      mac?: string
      vendorIds?: Record<string, string>
    }
  }

  export interface ConnectedLinkEndpoint {
    /** Node id (used to match against metrics / mapping data). */
    id: string
    /** Human-readable node label (falls back to id when no label is set). */
    label: string
  }

  export interface NodeSelectEvent {
    node: NodeInfo
    connectedLinks: Array<{
      id: string
      from: ConnectedLinkEndpoint
      to: ConnectedLinkEndpoint
      standard?: string
    }>
  }

  export interface LinkSelectEvent {
    link: {
      id: string
      label?: string
      labels?: string[]
      from: ConnectedLinkEndpoint & { port?: string }
      to: ConnectedLinkEndpoint & { port?: string }
      metadata?: Record<string, unknown>
      provenance?: NodeInfo['provenance']
      vlan?: number[]
      rateBps?: number
    }
  }

  export interface SubgraphInfo {
    id: string
    label: string
    nodeCount: number
    linkCount: number
    canDrillDown: boolean
    parent?: string
    members: Array<{ id: string; label: string; source?: string; role?: string }>
  }

  export interface SubgraphSelectEvent {
    subgraph: SubgraphInfo
  }
</script>

<script lang="ts">
  /**
   * Detail-page view of a topology. Composes the shared TopologyViewer
   * with the standard overlay set, plus detail-page chrome (breadcrumb,
   * zoom toolbar, legend, warnings).
   *
   * Kept as a named component (rather than inlined in the route) so
   * external imperative APIs (`panToNode`, `navigateToSheet`,
   * `getSvgElement`) used by the search palette and drill-down flows
   * continue to work without refactoring callers.
   */
  import { darkTheme, lightTheme, type NetworkGraph, type ResolvedLayout } from '@shumoku/core'
  import {
    ArrowLeftIcon,
    CornersOutIcon,
    GearSixIcon,
    MagnifyingGlassIcon,
    MagnifyingGlassMinusIcon,
    MagnifyingGlassPlusIcon,
  } from 'phosphor-svelte'
  import { onDestroy } from 'svelte'
  import { api } from '$lib/api'
  import {
    HighlightOverlay,
    type HoveredElement,
    NodeStatusOverlay,
    TooltipOverlay,
    TopologyViewer,
    WeathermapLinkOverlay,
  } from '$lib/components/topology'
  import {
    displaySettings,
    linkMapping,
    liveUpdatesEnabled,
    metricsData,
    metricsStore,
    metricsWarnings,
    nodeMapping,
    showNodeStatus,
    showTrafficFlow,
  } from '$lib/stores'
  import { resolvedTheme } from '$lib/stores/theme'
  import { formatTraffic } from '$lib/utils/format'
  import { nodeLabel, nodeLabelById } from '$lib/utils/node-label'
  import { getUtilizationColor, IDLE_LINK_METRICS, isLinkInstrumented } from '$lib/weathermap'

  // --- Props (Svelte 5 runes) ---
  interface Props {
    topologyId?: string
    readOnly?: boolean
    onToggleSettings?: () => void
    onSearchOpen?: () => void
    settingsOpen?: boolean
    onNodeSelect?: (event: NodeSelectEvent) => void
    onLinkSelect?: (event: LinkSelectEvent) => void
    onSubgraphSelect?: (event: SubgraphSelectEvent) => void
    onSheetChange?: (sheetId: string | null) => void
    allowLayoutEdit?: boolean
    /**
     * Override how the underlying NetworkGraph is fetched. Detail page
     * uses `topologyId` and the default fetcher. Share page passes a
     * token-scoped fetcher via this prop. The response may instead signal
     * `deriving` (server is still baking the first layout) or carry
     * `stale: true` (last-good diagram served while a re-bake runs) — both
     * make this component poll until the fresh bake lands.
     */
    graphLoader?: () => Promise<{
      graph?: NetworkGraph
      /** Server-baked layout for the root sheet — skips client computation. */
      resolved?: ResolvedLayout
      stale?: boolean
      deriving?: boolean
    }>
  }
  let {
    topologyId = '',
    readOnly = false,
    onToggleSettings,
    onSearchOpen,
    settingsOpen = false,
    onNodeSelect,
    onLinkSelect,
    onSubgraphSelect,
    onSheetChange,
    allowLayoutEdit = false,
    graphLoader,
  }: Props = $props()

  // --- State ---
  let graph = $state<NetworkGraph | undefined>(undefined)
  // Server-baked root layout. When present, TopologyViewer skips its own
  // computeNetworkLayout for the root sheet — a large layout recomputed on
  // the browser main thread froze the tab for minutes. Sheet drill-downs
  // still compute locally (child sheets are much smaller).
  let serverLayout = $state<ResolvedLayout | undefined>(undefined)
  let loading = $state(true)
  let error = $state('')
  // Server is baking the layout in the background (large topology). While a
  // previous diagram exists we keep showing it; otherwise the loading state
  // says what's happening instead of a bare spinner.
  let building = $state(false)
  let layoutEdit = $state(false)
  let selectedLayoutNode = $state<string | null>(null)
  let selectedLayoutLinkId = $state<string | null>(null)
  let selectedLayoutPinIds = $state<string[]>([])
  let pinnedPositions = $state<Record<string, { x: number; y: number }>>({})
  let portSides = $state<Record<string, 'top' | 'bottom' | 'left' | 'right'>>({})
  let portOrders = $state<Record<string, number>>({})
  let portOffsets = $state<Record<string, number>>({})
  let edgeRoutes = $state<Record<string, Array<{ x: number; y: number }>>>({})
  let layersOpen = $state(false)
  let nodeDetailsVisible = $state(true)
  let portLabelsVisible = $state(true)
  let linkLabelsVisible = $state(true)
  let pathExplorerOpen = $state(false)
  let pathSourceId = $state('')
  let pathDestinationId = $state('')
  let pathFlowId = $state('')

  type PathHop = { linkId: string; label: string; decision: string }
  type TrafficPath = { nodeIds: string[]; hops: PathHop[] }
  type TrafficFlowProfile = { id: string; label: string; source: string; destination: string }

  const pathNodes = $derived.by(() =>
    [...(graph?.nodes ?? [])]
      .map((node) => ({ id: node.id, label: nodeLabel(node) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  )

  function trafficDecision(link: Record<string, unknown>): string {
    const metadata = (link.metadata ?? {}) as Record<string, unknown>
    const explicit = String(metadata.decision ?? '').toUpperCase()
    if (['ALLOW', 'BLOCK', 'NAT', 'VPN', 'UNKNOWN'].includes(explicit)) return explicit
    const label = String(link.label ?? '').toLowerCase()
    if (/block|deny|reject/.test(label)) return 'BLOCK'
    if (/dnat|snat|nat/.test(label)) return 'NAT'
    if (/ipsec|vpn|wireguard/.test(label)) return 'VPN'
    if (/allow|routing|uplink|control|overlay/.test(label)) return 'ALLOW'
    return 'UNKNOWN'
  }

  function findTrafficPath(requiredService = 'any'): TrafficPath | null {
    if (!graph || !pathSourceId || !pathDestinationId || pathSourceId === pathDestinationId)
      return null
    const sourceLabel = nodeLabel(graph.nodes.find((node) => node.id === pathSourceId)).toLowerCase()
    const kerioAccessPath = sourceLabel.includes('remote vpn users') || sourceLabel.includes('kerio')
    const adjacency = new Map<string, Array<{ nodeId: string; link: Record<string, unknown> }>>()
    for (const rawLink of graph.links) {
      const item = rawLink as unknown as Record<string, unknown>
      const from = String((item.from as { node?: string })?.node ?? '')
      const to = String((item.to as { node?: string })?.node ?? '')
      if (!from || !to) continue
      const label = String(item.label ?? '')
      // A road-warrior session terminates on Kerio after OPNsense DNAT. The
      // generic OPNsense → LAN routing edge is physically shorter, but it is
      // not the path taken by these clients and must not hide the VPN gateway.
      if (kerioAccessPath && /^(local|lan) routing$/i.test(label)) continue
      const arrow = String(item.arrow ?? 'both')
      if (arrow !== 'reverse') adjacency.set(from, [...(adjacency.get(from) ?? []), { nodeId: to, link: item }])
      if (arrow !== 'forward') adjacency.set(to, [...(adjacency.get(to) ?? []), { nodeId: from, link: item }])
    }
    const startKey = `${pathSourceId}|${requiredService === 'any' ? 1 : 0}`
    const queue = [{ nodeId: pathSourceId, matched: requiredService === 'any' }]
    const previous = new Map<
      string,
      { key: string; nodeId: string; matched: boolean; link: Record<string, unknown> }
    >()
    const visited = new Set([startKey])
    let goalKey = ''
    while (queue.length) {
      const current = queue.shift()!
      const currentKey = `${current.nodeId}|${current.matched ? 1 : 0}`
      if (current.nodeId === pathDestinationId && current.matched) {
        goalKey = currentKey
        break
      }
      for (const next of adjacency.get(current.nodeId) ?? []) {
        const matched = current.matched || String(next.link.label ?? '') === requiredService
        const nextKey = `${next.nodeId}|${matched ? 1 : 0}`
        if (visited.has(nextKey)) continue
        visited.add(nextKey)
        previous.set(nextKey, {
          key: currentKey,
          nodeId: current.nodeId,
          matched: current.matched,
          link: next.link,
        })
        queue.push({ nodeId: next.nodeId, matched })
      }
    }
    if (!goalKey) return null
    const nodeIds = [pathDestinationId]
    const hops: PathHop[] = []
    let cursorKey = goalKey
    while (cursorKey !== startKey) {
      const step = previous.get(cursorKey)
      if (!step) return null
      hops.unshift({
        linkId: String(step.link.id ?? ''),
        label: String(step.link.label ?? 'unlabelled connection'),
        decision: trafficDecision(step.link),
      })
      nodeIds.unshift(step.nodeId)
      cursorKey = step.key
    }
    return { nodeIds, hops }
  }

  const trafficFlowProfiles = $derived.by<TrafficFlowProfile[]>(() => {
    const metadata = (graph as unknown as { metadata?: { trafficFlows?: unknown[] } })?.metadata
    const resolvedIds = new Map(
      (graph?.nodes ?? []).map((node) => [
        String((node as unknown as { metadata?: { logicalId?: string } }).metadata?.logicalId ?? node.id),
        node.id,
      ]),
    )
    const nodeFlows = (graph?.nodes ?? []).flatMap((node) => {
      const nodeMetadata = (node as unknown as { metadata?: { trafficFlows?: unknown[] } }).metadata
      return (nodeMetadata?.trafficFlows ?? []).map((item) => {
        const flow = item as TrafficFlowProfile
        return {
          ...flow,
          source: resolvedIds.get(flow.source) ?? node.id,
          destination: resolvedIds.get(flow.destination) ?? flow.destination,
        }
      })
    })
    const profiles = [...(metadata?.trafficFlows ?? []), ...nodeFlows].filter((item): item is TrafficFlowProfile => {
      const flow = item as Partial<TrafficFlowProfile>
      return Boolean(flow.id && flow.label && flow.source && flow.destination)
    })
    return [...new Map(profiles.map((flow) => [flow.id, flow])).values()]
  })
  const availableTrafficFlows = $derived(trafficFlowProfiles)

  $effect(() => {
    if (!pathFlowId) return
    const selected = trafficFlowProfiles.find((flow) => flow.id === pathFlowId)
    if (!selected) pathFlowId = ''
  })

  function selectTrafficFlow(flowId: string) {
    const selected = trafficFlowProfiles.find((flow) => flow.id === flowId)
    if (!selected) {
      pathFlowId = ''
      return
    }
    pathSourceId = selected.source
    pathDestinationId = selected.destination
    pathFlowId = flowId
  }

  const trafficPath = $derived.by<TrafficPath | null>(() => findTrafficPath())

  const highlightedPathNodes = $derived(new Set(trafficPath?.nodeIds ?? []))
  const highlightedPathLinks = $derived(new Set(trafficPath?.hops.map((hop) => hop.linkId) ?? []))
  const controlPlanePath = $derived.by(() => {
    const nodeIds = new Set<string>()
    const linkIds = new Set<string>()
    const sourceLabel = nodeLabel(graph?.nodes.find((node) => node.id === pathSourceId)).toLowerCase()
    if (!graph || !sourceLabel.includes('netbird'))
      return { nodeIds, linkIds }
    for (const rawLink of graph.links) {
      const item = rawLink as unknown as Record<string, unknown>
      if (String(item.label ?? '').trim().toLowerCase() !== 'control') continue
      const from = String((item.from as { node?: string })?.node ?? '')
      const to = String((item.to as { node?: string })?.node ?? '')
      if (from) nodeIds.add(from)
      if (to) nodeIds.add(to)
      linkIds.add(String(item.id ?? ''))
    }
    return { nodeIds, linkIds }
  })

  type OperatorLayout = {
    nodePositions: Record<string, { x: number; y: number }>
    portSides: Record<string, 'top' | 'bottom' | 'left' | 'right'>
    portOrders: Record<string, number>
    portOffsets: Record<string, number>
    edgeRoutes: Record<string, Array<{ x: number; y: number }>>
  }

  const pinStorageKey = $derived(`shumoku-layout-pins:${topologyId}`)
  const portStorageKey = $derived(`shumoku-layout-port-sides:${topologyId}`)
  const layerStorageKey = $derived(`shumoku-view-layers:${topologyId}`)

  function loadLayerPreferences() {
    if (typeof localStorage === 'undefined' || !topologyId) return
    try {
      const saved = JSON.parse(localStorage.getItem(layerStorageKey) ?? '{}')
      nodeDetailsVisible = saved.nodeDetails ?? true
      portLabelsVisible = saved.portLabels ?? true
      linkLabelsVisible = saved.linkLabels ?? true
    } catch {
      nodeDetailsVisible = true
      portLabelsVisible = true
      linkLabelsVisible = true
    }
  }

  function saveLayerPreferences() {
    if (typeof localStorage === 'undefined' || !topologyId) return
    localStorage.setItem(
      layerStorageKey,
      JSON.stringify({
        nodeDetails: nodeDetailsVisible,
        portLabels: portLabelsVisible,
        linkLabels: linkLabelsVisible,
      }),
    )
  }

  function setLayer(layer: 'nodeDetails' | 'portLabels' | 'linkLabels', enabled: boolean) {
    if (layer === 'nodeDetails') nodeDetailsVisible = enabled
    if (layer === 'portLabels') portLabelsVisible = enabled
    if (layer === 'linkLabels') linkLabelsVisible = enabled
    saveLayerPreferences()
  }

  type ViewPreset = 'full' | 'overview' | 'troubleshooting'

  const activeViewPreset = $derived.by<ViewPreset | null>(() => {
    if (
      nodeDetailsVisible &&
      portLabelsVisible &&
      linkLabelsVisible &&
      $showTrafficFlow &&
      $showNodeStatus
    )
      return 'full'
    if (
      !nodeDetailsVisible &&
      !portLabelsVisible &&
      linkLabelsVisible &&
      !$showTrafficFlow &&
      !$showNodeStatus
    )
      return 'overview'
    if (
      nodeDetailsVisible &&
      portLabelsVisible &&
      linkLabelsVisible &&
      !$showTrafficFlow &&
      $showNodeStatus
    )
      return 'troubleshooting'
    return null
  })

  function applyViewPreset(preset: ViewPreset) {
    nodeDetailsVisible = preset !== 'overview'
    portLabelsVisible = preset !== 'overview'
    linkLabelsVisible = true
    saveLayerPreferences()
    displaySettings.setShowTrafficFlow(preset === 'full')
    displaySettings.setShowNodeStatus(preset !== 'overview')
  }

  function readPins(): Record<string, { x: number; y: number }> {
    if (typeof localStorage === 'undefined' || !topologyId) return {}
    try {
      return JSON.parse(localStorage.getItem(pinStorageKey) ?? '{}')
    } catch {
      return {}
    }
  }

  function writePins(next: Record<string, { x: number; y: number }>) {
    pinnedPositions = next
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(pinStorageKey, JSON.stringify(next))
    void persistOperatorLayout(next, portSides, portOrders, portOffsets, edgeRoutes)
  }

  function readPortSides(): Record<string, 'top' | 'bottom' | 'left' | 'right'> {
    if (typeof localStorage === 'undefined' || !topologyId) return {}
    try {
      return JSON.parse(localStorage.getItem(portStorageKey) ?? '{}')
    } catch {
      return {}
    }
  }

  function writePortSides(next: Record<string, 'top' | 'bottom' | 'left' | 'right'>) {
    portSides = next
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(portStorageKey, JSON.stringify(next))
    void persistOperatorLayout(pinnedPositions, next, portOrders, portOffsets, edgeRoutes)
  }

  async function persistOperatorLayout(
    nodePositions: Record<string, { x: number; y: number }>,
    sides: Record<string, 'top' | 'bottom' | 'left' | 'right'>,
    orders: Record<string, number>,
    offsets: Record<string, number>,
    routes: Record<string, Array<{ x: number; y: number }>>,
  ) {
    if (!topologyId || readOnly) return
    await api.topologies.displaySettings.set(topologyId, {
      operatorLayout: {
        nodePositions,
        portSides: sides,
        portOrders: orders,
        portOffsets: offsets,
        edgeRoutes: routes,
      },
    })
  }

  function applyLayoutOverrides(
    source: NetworkGraph,
    pins: Record<string, { x: number; y: number }>,
    sides: Record<string, 'top' | 'bottom' | 'left' | 'right'>,
    orders: Record<string, number> = portOrders,
    offsets: Record<string, number> = portOffsets,
  ): NetworkGraph {
    if (Object.keys(pins).length === 0 && Object.keys(sides).length === 0) return source
    return {
      ...source,
      nodes: source.nodes.map((node) => ({
        ...node,
        ...(pins[node.id] ? { position: pins[node.id] } : {}),
        ...(node.ports
          ? {
              ports: node.ports.map((port) => {
                const side = sides[`${node.id}:${port.id}`]
                const order = orders[`${node.id}:${port.id}`]
                const offset = offsets[`${node.id}:${port.id}`]
                return side || order !== undefined || offset !== undefined
                  ? {
                      ...port,
                      placement: {
                        ...port.placement,
                        ...(side ? { side } : {}),
                        ...(order !== undefined ? { order } : {}),
                        ...(offset !== undefined ? { offset } : {}),
                      },
                    }
                  : port
              }),
            }
          : {}),
      })),
    }
  }

  // Drill-down navigation stack. `currentSheetId === null` means root.
  let currentSheetId = $state<string | null>(null)
  let navigationStack = $state<string[]>([])

  $effect(() => {
    onSheetChange?.(currentSheetId)
  })

  let viewer: ReturnType<typeof TopologyViewer> | undefined = $state()

  const currentTheme = $derived($resolvedTheme === 'dark' ? darkTheme : lightTheme)

  // --- Data loading ---

  // Poll timer for server-side bakes: short interval while the first layout
  // is being built (no diagram yet), longer while a stale diagram is shown.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  function scheduleRefresh(ms: number) {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => void loadGraph(), ms)
  }
  onDestroy(() => clearTimeout(refreshTimer))

  // Non-reactive mirror of "a graph has been shown at least once". loadGraph
  // is invoked from a $effect; reading the `graph` $state there would register
  // it as a dependency, and since loadGraph also WRITES `graph`, that loops
  // forever (refetch → new graph → effect refires → refetch …).
  let hasGraph = false

  async function loadGraph() {
    // Keep the current diagram visible during a stale-refresh poll — only
    // show the loading state when there is nothing on screen yet.
    loading = !hasGraph
    error = ''
    try {
      loadLayerPreferences()
      const loader = graphLoader ?? (() => api.topologies.getView(topologyId))
      const [res, display] = await Promise.all([
        loader(),
        readOnly || !topologyId
          ? Promise.resolve(null)
          : api.topologies.displaySettings.get(topologyId),
      ])
      if (res.deriving) {
        building = true
        loading = !hasGraph
        scheduleRefresh(3000)
        return
      }
      if (res.graph) {
        const saved = (display as { operatorLayout?: OperatorLayout } | null)?.operatorLayout
        const localPins = readPins()
        const localSides = readPortSides()
        const serverHasLayout =
          saved &&
          (Object.keys(saved.nodePositions).length > 0 ||
            Object.keys(saved.portSides).length > 0 ||
            Object.keys(saved.portOrders ?? {}).length > 0 ||
            Object.keys(saved.portOffsets ?? {}).length > 0 ||
            Object.keys(saved.edgeRoutes ?? {}).length > 0)
        const pins = serverHasLayout ? saved.nodePositions : localPins
        const sides = serverHasLayout ? saved.portSides : localSides
        const orders = serverHasLayout ? (saved.portOrders ?? {}) : {}
        const offsets = serverHasLayout ? (saved.portOffsets ?? {}) : {}
        edgeRoutes = saved?.edgeRoutes ?? {}
        pinnedPositions = pins
        portSides = sides
        portOrders = orders
        portOffsets = offsets
        if (
          !serverHasLayout &&
          (Object.keys(localPins).length > 0 || Object.keys(localSides).length > 0)
        ) {
          void persistOperatorLayout(localPins, localSides, {}, {}, {})
        }
        graph = applyLayoutOverrides(res.graph, pins, sides, orders, offsets)
        // Pinned positions require a fresh client layout so ports and routes
        // are recalculated around the operator's saved placement.
        serverLayout =
          Object.keys(pins).length || Object.keys(sides).length ? undefined : res.resolved
        hasGraph = true
      }
      building = res.stale === true
      if (res.stale) scheduleRefresh(5000)
      loading = false
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error'
      loading = false
    }
  }

  const sheetsAvailable = $derived.by(() => {
    if (!graph?.subgraphs) return new Map<string, string>()
    const m = new Map<string, string>()
    for (const sg of graph.subgraphs) {
      if (!sg.parent) m.set(sg.id, sg.label ?? sg.id)
    }
    return m
  })

  const isHierarchical = $derived(sheetsAvailable.size > 0)

  const currentSheetLabel = $derived(
    currentSheetId ? (sheetsAvailable.get(currentSheetId) ?? currentSheetId) : 'Root',
  )

  // --- External imperative API (preserved from old implementation) ---

  export function getSvgElement(): SVGSVGElement | null {
    return viewer?.getSvgElement() ?? null
  }

  export function getGraph(): NetworkGraph | undefined {
    return graph
  }

  export async function refreshGraph(): Promise<void> {
    await loadGraph()
  }

  export function panToNode(nodeId: string): void {
    viewer?.panToNode(nodeId)
  }

  export function navigateToSheet(sheetId: string): void {
    if (!sheetsAvailable.has(sheetId)) return
    if (currentSheetId) navigationStack = [...navigationStack, currentSheetId]
    currentSheetId = sheetId
  }

  function navigateBack() {
    if (navigationStack.length === 0) {
      currentSheetId = null
      return
    }
    const prev = navigationStack[navigationStack.length - 1] ?? null
    navigationStack = navigationStack.slice(0, -1)
    currentSheetId = prev
  }

  // --- Selection handling ---

  function handleSelect(id: string | null, type: string | null) {
    if (layoutEdit) {
      selectedLayoutLinkId = type === 'edge' ? id : null
      selectedLayoutNode = id
      selectedLayoutPinIds =
        type === 'node'
          ? id && pinnedPositions[id]
            ? [id]
            : []
          : id && type === 'subgraph'
            ? pinnedNodeIdsInSubgraph(id)
            : []
      return
    }
    if (!id || !type || !graph) return
    if (type === 'node') emitNodeSelect(id)
    else if (type === 'edge') emitLinkSelect(id)
    else if (type === 'subgraph') emitSubgraphSelect(id)
  }

  function pinnedNodeIdsInSubgraph(subgraphId: string): string[] {
    if (!graph) return []
    const parents = new Map((graph.subgraphs ?? []).map((sg) => [sg.id, sg.parent]))
    const isInside = (nodeId: string) => {
      let parent = graph?.nodes.find((node) => node.id === nodeId)?.parent
      while (parent) {
        if (parent === subgraphId) return true
        parent = parents.get(parent)
      }
      return false
    }
    return Object.keys(pinnedPositions).filter(isInside)
  }

  function handleLayoutDragEnd(id: string, positions: Record<string, { x: number; y: number }>) {
    if (!layoutEdit || Object.keys(positions).length === 0) return
    selectedLayoutNode = id
    selectedLayoutPinIds = Object.keys(positions)
    writePins({ ...pinnedPositions, ...positions })
  }

  function handlePortMove(
    nodeId: string,
    portId: string,
    side: 'top' | 'bottom' | 'left' | 'right',
    order: number,
    offset: number,
  ) {
    if (!layoutEdit || !graph) return
    const next = { ...portSides, [`${nodeId}:${portId}`]: side }
    const node = graph.nodes.find((candidate) => candidate.id === nodeId)
    const siblings = (node?.ports ?? []).filter(
      (port) =>
        port.id !== portId && (next[`${nodeId}:${port.id}`] ?? port.placement?.side) === side,
    )
    siblings.sort(
      (a, b) =>
        (portOrders[`${nodeId}:${a.id}`] ?? a.placement?.order ?? 999) -
        (portOrders[`${nodeId}:${b.id}`] ?? b.placement?.order ?? 999),
    )
    siblings.splice(Math.min(order, siblings.length), 0, {
      id: portId,
    } as (typeof siblings)[number])
    const nextOrders = { ...portOrders }
    siblings.forEach((port, index) => {
      nextOrders[`${nodeId}:${port.id}`] = index
    })
    portOrders = nextOrders
    const nextOffsets = { ...portOffsets, [`${nodeId}:${portId}`]: offset }
    portOffsets = nextOffsets
    writePortSides(next)
    void persistOperatorLayout(pinnedPositions, next, nextOrders, nextOffsets, edgeRoutes)
    graph = applyLayoutOverrides(graph, pinnedPositions, next, nextOrders, nextOffsets)
    serverLayout = undefined
  }

  function unpinSelected() {
    if (!selectedLayoutNode) return
    const next = { ...pinnedPositions }
    for (const id of selectedLayoutPinIds) delete next[id]
    writePins(next)
    selectedLayoutNode = null
    selectedLayoutPinIds = []
    void loadGraph()
  }

  function resetOperatorLayout() {
    edgeRoutes = {}
    portOrders = {}
    portOffsets = {}
    writePins({})
    writePortSides({})
    selectedLayoutNode = null
    selectedLayoutLinkId = null
    selectedLayoutPinIds = []
    void loadGraph()
  }

  function saveRoute(id: string, bends: Array<{ x: number; y: number }> | null) {
    const next = { ...edgeRoutes }
    if (bends !== null) next[id] = bends
    else delete next[id]
    edgeRoutes = next
    void persistOperatorLayout(pinnedPositions, portSides, portOrders, portOffsets, next)
  }

  function addRoutePoint(id: string, x: number, y: number, index: number) {
    if (!layoutEdit || !graph) return
    const bends = edgeRoutes[id] ?? []
    saveRoute(id, [...bends.slice(0, index), { x, y }, ...bends.slice(index)])
  }
  function moveRoutePoint(id: string, index: number, x: number, y: number) {
    const bends = edgeRoutes[id]
    if (!layoutEdit || !bends?.[index]) return
    saveRoute(
      id,
      bends.map((point, i) => (i === index ? { x, y } : point)),
    )
  }
  function removeRoutePoint(id: string, index: number) {
    const bends = edgeRoutes[id]
    if (!layoutEdit || !bends) return
    saveRoute(
      id,
      bends.filter((_, i) => i !== index),
    )
  }

  function emitNodeSelect(nodeId: string) {
    if (!graph || !onNodeSelect) return
    const node = graph.nodes.find((n) => n.id === nodeId)
    if (!node) return
    const nodes = graph.nodes
    const connectedLinks = graph.links
      .filter((l) => {
        const from = typeof l.from === 'string' ? l.from : l.from.node
        const to = typeof l.to === 'string' ? l.to : l.to.node
        return from === nodeId || to === nodeId
      })
      .map((l) => {
        const fromId = l.from.node
        const toId = l.to.node
        return {
          id: l.id ?? `${fromId}->${toId}`,
          from: { id: fromId, label: nodeLabelById(nodes, fromId) },
          to: { id: toId, label: nodeLabelById(nodes, toId) },
          standard: l.from.plug?.module?.standard ?? l.to.plug?.module?.standard,
        }
      })
    onNodeSelect({
      node: {
        id: node.id,
        label: nodeLabel(node),
        labels: Array.isArray(node.label) ? node.label : [node.label ?? node.id],
        parent: node.parent,
        metadata: node.metadata,
        ports: node.ports?.map((port) => ({
          id: port.id,
          label: port.label,
          side: port.placement?.side,
        })),
        spec: node.spec
          ? {
              type: 'type' in node.spec ? node.spec.type : undefined,
              vendor: 'vendor' in node.spec ? node.spec.vendor : undefined,
              model: 'model' in node.spec ? node.spec.model : undefined,
            }
          : undefined,
        provenance: node.provenance,
        identity: node.identity,
      },
      connectedLinks,
    })
  }

  function emitLinkSelect(linkId: string) {
    if (!graph || !onLinkSelect) return
    const link = graph.links.find((candidate) => candidate.id === linkId)
    if (!link) return
    const fromId = link.from.node
    const toId = link.to.node
    const rawLabel = link.label
    onLinkSelect({
      link: {
        id: link.id ?? `${fromId}->${toId}`,
        label: Array.isArray(rawLabel) ? rawLabel.join(' ') : rawLabel,
        labels: Array.isArray(rawLabel) ? rawLabel : rawLabel ? [rawLabel] : undefined,
        from: {
          id: fromId,
          label: nodeLabelById(graph.nodes, fromId),
          port: link.from.port,
        },
        to: {
          id: toId,
          label: nodeLabelById(graph.nodes, toId),
          port: link.to.port,
        },
        metadata: link.metadata,
        provenance: link.provenance,
        vlan: link.vlan,
        rateBps: link.rateBps,
      },
    })
  }

  function emitSubgraphSelect(sgId: string) {
    if (!graph || !onSubgraphSelect) return
    const sg = graph.subgraphs?.find((s) => s.id === sgId)
    if (!sg) return

    const parents = new Map((graph.subgraphs ?? []).map((candidate) => [candidate.id, candidate.parent]))
    const belongsToSubgraph = (nodeParent?: string) => {
      let parent = nodeParent
      while (parent) {
        if (parent === sgId) return true
        parent = parents.get(parent)
      }
      return false
    }
    const memberNodes = graph.nodes.filter((node) => belongsToSubgraph(node.parent))
    const memberIds = new Set(memberNodes.map((n) => n.id))
    const linkCount = graph.links.filter((l) => {
      const from = typeof l.from === 'string' ? l.from : l.from.node
      const to = typeof l.to === 'string' ? l.to : l.to.node
      return memberIds.has(from) || memberIds.has(to)
    }).length

    onSubgraphSelect({
      subgraph: {
        id: sgId,
        label: sg.label ?? sgId,
        nodeCount: memberNodes.length,
        linkCount,
        canDrillDown: sheetsAvailable.has(sgId),
        parent: sg.parent,
        members: memberNodes.map((node) => ({
          id: node.id,
          label: nodeLabel(node),
          source: typeof node.metadata?.source === 'string' ? node.metadata.source : undefined,
          role: typeof node.metadata?.role === 'string' ? node.metadata.role : undefined,
        })),
      },
    })
  }

  // --- Metrics-layer membership (mapping) vs live values (metrics) ---
  // An overlay is shown when the element BELONGS to the metrics layer (is mapped);
  // live values only decide its appearance. Membership and values are two inputs,
  // composed here so the overlays stay pure renderers. A mapped node the live feed
  // omits gets a neutral 'unknown' marker (present, but no value yet). Where the
  // mapping store isn't hydrated (widgets, shared views) `$nodeMapping` is empty,
  // so this collapses to exactly the previous values-only behaviour.
  const nodeStatusView = $derived.by(() => {
    const live = $metricsData?.nodes
    const mapped = $nodeMapping
    if (!mapped || Object.keys(mapped).length === 0) return live
    const out: Record<string, { status: string; monitoring?: string }> = { ...(live ?? {}) }
    for (const [nodeId, m] of Object.entries(mapped)) {
      if (m?.hostId && !out[nodeId]) out[nodeId] = { status: 'unknown' }
    }
    return out
  })

  // --- Tooltip content: live metrics-aware for links ---

  function buildTooltip(hovered: HoveredElement, g: NetworkGraph): string {
    if (hovered.kind === 'node') {
      return `<strong>${escapeHtml(nodeLabelById(g.nodes, hovered.id))}</strong>`
    }
    if (hovered.kind === 'subgraph') {
      const sg = g.subgraphs?.find((x) => x.id === hovered.id)
      return `<strong>${escapeHtml(sg?.label ?? hovered.id)}</strong>`
    }
    // Link: show endpoints + live metrics if available
    const link = g.links.find((x) => x.id === hovered.id)
    if (!link) return `<strong>${escapeHtml(hovered.id)}</strong>`
    const from = nodeLabelById(g.nodes, link.from.node)
    const to = nodeLabelById(g.nodes, link.to.node)
    let out = `<strong>${escapeHtml(from)} → ${escapeHtml(to)}</strong>`
    const std = link.from.plug?.module?.standard ?? link.to.plug?.module?.standard
    if (std) out += `<br><span class="muted">Standard: ${escapeHtml(String(std))}</span>`

    const m = $metricsData?.links?.[hovered.id]
    if (m) {
      if (m.inBps !== undefined || m.outBps !== undefined) {
        out += `<br><span class="muted">In:</span> ${formatTraffic(m.inBps ?? 0)} <span class="muted">Out:</span> ${formatTraffic(m.outBps ?? 0)}`
      }
      if (m.inUtilization !== undefined || m.outUtilization !== undefined) {
        const inU = m.inUtilization ?? 0
        const outU = m.outUtilization ?? 0
        out += `<br><span style="color: ${getUtilizationColor(inU)}">In: ${inU.toFixed(1)}%</span> <span style="color: ${getUtilizationColor(outU)}">Out: ${outU.toFixed(1)}%</span>`
      } else if (m.utilization !== undefined) {
        out += `<br><span style="color: ${getUtilizationColor(m.utilization)}">Utilization: ${m.utilization.toFixed(1)}%</span>`
      }
      out += `<br><span class="muted">Status: ${escapeHtml(String(m.status))}</span>`
    }
    return out
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // --- Data loading: re-fetch when topologyId changes (component reused on
  // same-route navigation) ---

  $effect(() => {
    // Track topologyId so the effect re-runs when the route id changes.
    topologyId
    hasGraph = false
    loadGraph()
  })

  // --- Live metrics subscription ---

  $effect(() => {
    if (readOnly || !$liveUpdatesEnabled || !topologyId) return
    metricsStore.connect()
    metricsStore.subscribeToTopology(topologyId)
    return () => {
      metricsStore.unsubscribe()
    }
  })

  // --- Keyboard shortcut for search palette ---

  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k' && onSearchOpen) {
      e.preventDefault()
      onSearchOpen()
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="diagram-container">
  {#if loading}
    <div class="loading">
      <div class="spinner"></div>
      <span>{building ? 'Computing layout… (large topology)' : 'Loading topology...'}</span>
    </div>
  {:else if error}
    <div class="error">
      <span class="error-icon">!</span>
      <span>{error}</span>
    </div>
  {:else if graph}
    {#if isHierarchical && currentSheetId !== null}
      <div class="breadcrumb">
        <button class="breadcrumb-back" onclick={navigateBack} title="Go back">
          <ArrowLeftIcon size={14} />
        </button>
        <span class="breadcrumb-current">{currentSheetLabel}</span>
      </div>
    {/if}

    {#if $liveUpdatesEnabled && $metricsWarnings.length > 0}
      <div class="warnings-banner">
        {#each $metricsWarnings as warning}
          <span class="warning-text">{warning}</span>
        {/each}
      </div>
    {/if}

    <TopologyViewer
      bind:this={viewer}
      {graph}
      sheetId={currentSheetId}
      layout={currentSheetId ? undefined : serverLayout}
      theme={currentTheme}
      mode={layoutEdit ? 'edit' : 'view'}
      sheetCacheStrategy="lazy"
      onselect={handleSelect}
      ondragend={handleLayoutDragEnd}
      onportmove={handlePortMove}
      routeOverrides={edgeRoutes}
      onrouteadd={addRoutePoint}
      onroutemove={moveRoutePoint}
      onrouteremove={removeRoutePoint}
      detail={{
    nodeDetails: nodeDetailsVisible,
    portLabels: portLabelsVisible,
    linkLabels: linkLabelsVisible,
  }}
    >
      {#snippet linkOverlay(
    edge,
    context,
  )}
        <WeathermapLinkOverlay
          {context}
          metrics={$metricsData?.links?.[edge.id] ??
    (isLinkInstrumented($linkMapping?.[edge.id]) ? IDLE_LINK_METRICS : undefined)}
          enabled={$liveUpdatesEnabled && $showTrafficFlow}
        />
      {/snippet}
      {#snippet children({
    svgElement,
    graph: activeGraph,
  })}
        <NodeStatusOverlay
          {svgElement}
          status={nodeStatusView}
          enabled={$liveUpdatesEnabled && $showNodeStatus}
        />
        <HighlightOverlay
          {svgElement}
          highlightedIds={highlightedPathNodes}
          highlightedLinkIds={highlightedPathLinks}
          secondaryHighlightedIds={controlPlanePath.nodeIds}
          secondaryHighlightedLinkIds={controlPlanePath.linkIds}
          dimOthers={pathExplorerOpen && highlightedPathNodes.size > 0}
          highlightColor="#2563eb"
          secondaryHighlightColor="#8b5cf6"
          pulseAnimation={false}
        />
        <TooltipOverlay {svgElement} graph={activeGraph} contentBuilder={buildTooltip} />
      {/snippet}
    </TopologyViewer>
  {/if}

  <!-- Zoom / utility controls -->
  <div class="controls">
    <div class="control-group">
      <button onclick={() => viewer?.zoomBy(1.5)} title="Zoom In">
        <MagnifyingGlassPlusIcon size={18} />
      </button>
      <button onclick={() => viewer?.zoomBy(1 / 1.5)} title="Zoom Out">
        <MagnifyingGlassMinusIcon size={18} />
      </button>
    </div>
    <div class="control-group">
      {#if allowLayoutEdit && !readOnly}
        <button
          onclick={() => (layoutEdit = !layoutEdit)}
          title={layoutEdit
    ? 'Finish layout editing; double-click a link to add a bend, drag the handle to move it, double-click the handle to remove it'
    : 'Move nodes and ports; edit link bends'}
          class:active={layoutEdit}
        >
          {layoutEdit ? '✓' : '↔'}
        </button>
        {#if layoutEdit && selectedLayoutNode && selectedLayoutPinIds.length > 0}
          <button onclick={unpinSelected} title="Unpin selected node or block">×</button>
        {/if}
        {#if layoutEdit && selectedLayoutLinkId}
          <button
            onclick={() => selectedLayoutLinkId && saveRoute(selectedLayoutLinkId, null)}
            class:active={!Object.hasOwn(edgeRoutes, selectedLayoutLinkId)}
            title="Automatically route selected link around nodes"
          >
            Auto
          </button>
          <button
            onclick={() => selectedLayoutLinkId && saveRoute(selectedLayoutLinkId, [])}
            class:active={Object.hasOwn(edgeRoutes, selectedLayoutLinkId) && edgeRoutes[selectedLayoutLinkId]?.length === 0}
            title="Draw selected link directly between its ports"
          >
            Straight
          </button>
          {#if (edgeRoutes[selectedLayoutLinkId]?.length ?? 0) > 0}
            <span class="route-mode" title="Drag bends to adjust the manual route">Manual</span>
          {/if}
        {/if}
        {#if layoutEdit &&
    (Object.keys(pinnedPositions).length > 0 ||
      Object.keys(portSides).length > 0 ||
      Object.keys(edgeRoutes).length > 0)}
          <button onclick={resetOperatorLayout} title="Reset all saved layout">Reset</button>
        {/if}
      {/if}
      <button onclick={() => viewer?.resetZoom()} title="Fit to View">
        <CornersOutIcon size={18} />
      </button>
      {#if onSearchOpen}
        <button onclick={onSearchOpen} title="Search Nodes (Cmd/Ctrl+K)">
          <MagnifyingGlassIcon size={18} />
        </button>
      {/if}
      {#if onToggleSettings}
        <button onclick={onToggleSettings} title="Settings" class:active={settingsOpen}>
          <GearSixIcon size={18} />
        </button>
      {/if}
      <button
        onclick={() => (layersOpen = !layersOpen)}
        title="Information layers"
        class:active={layersOpen}
      >
        Layers
      </button>
      <button
        onclick={() => (pathExplorerOpen = !pathExplorerOpen)}
        title="Trace traffic path"
        class:active={pathExplorerOpen}
      >
        Path
      </button>
    </div>
  </div>

  {#if layersOpen}
    <div class="layers-panel">
      <div class="layers-title">Information layers</div>
      <div class="view-presets" aria-label="View presets">
        <button class:active={activeViewPreset === 'full'} onclick={() => applyViewPreset('full')}>
          Full
        </button>
        <button
          class:active={activeViewPreset === 'overview'}
          onclick={() => applyViewPreset('overview')}
        >
          Overview
        </button>
        <button
          class:active={activeViewPreset === 'troubleshooting'}
          onclick={() => applyViewPreset('troubleshooting')}
        >
          Troubleshoot
        </button>
      </div>
      <label
        ><input
          type="checkbox"
          checked={nodeDetailsVisible}
          onchange={(e) => setLayer('nodeDetails', e.currentTarget.checked)}
        >
        Node details</label
      >
      <label
        ><input
          type="checkbox"
          checked={portLabelsVisible}
          onchange={(e) => setLayer('portLabels', e.currentTarget.checked)}
        >
        Port labels</label
      >
      <label
        ><input
          type="checkbox"
          checked={linkLabelsVisible}
          onchange={(e) => setLayer('linkLabels', e.currentTarget.checked)}
        >
        Link labels</label
      >
      <label
        ><input
          type="checkbox"
          checked={$showNodeStatus}
          onchange={(e) => displaySettings.setShowNodeStatus(e.currentTarget.checked)}
        >
        Health status</label
      >
      <label
        ><input
          type="checkbox"
          checked={$showTrafficFlow}
          onchange={(e) => displaySettings.setShowTrafficFlow(e.currentTarget.checked)}
        >
        Traffic utilization</label
      >
    </div>
  {/if}

  {#if pathExplorerOpen}
    <div class="path-panel">
      <div class="layers-title">Traffic path</div>
      <label>Source
        <select bind:value={pathSourceId}>
          <option value="">Select source</option>
          {#each pathNodes as item}<option value={item.id}>{item.label}</option>{/each}
        </select>
      </label>
      <label>Destination
        <select bind:value={pathDestinationId}>
          <option value="">Select destination</option>
          {#each pathNodes as item}<option value={item.id}>{item.label}</option>{/each}
        </select>
      </label>
      <label>Traffic flow
        <select value={pathFlowId} onchange={(event) => selectTrafficFlow(event.currentTarget.value)}>
          <option value="">Select operational flow</option>
          {#each availableTrafficFlows as flow}<option value={flow.id}>{flow.label}</option>{/each}
        </select>
      </label>
      {#if pathSourceId && pathDestinationId}
        {#if trafficPath}
          <div class="path-result">
            {#each trafficPath.hops as hop, index}
              <div class="path-hop">
                <span class="decision {hop.decision.toLowerCase()}">{hop.decision}</span>
                <span>{hop.label}</span>
                {#if index < trafficPath.hops.length - 1}<span class="path-arrow">→</span>{/if}
              </div>
            {/each}
            {#if controlPlanePath.linkIds.size > 0}
              <div class="path-hop control-plane-hop">
                <span class="decision control">CONTROL</span>
                <span>NetBird management / signaling</span>
              </div>
            {/if}
          </div>
        {:else}
          <div class="path-empty">UNKNOWN · no matching path</div>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Legend (only when traffic flow is on) -->
  {#if $liveUpdatesEnabled && $showTrafficFlow}
    <div class="legend">
      <div class="legend-title">Utilization</div>
      <div class="legend-items">
        <div class="legend-item">
          <span class="legend-color" style="background: #22c55e"></span>
          <span>0-25%</span>
        </div>
        <div class="legend-item">
          <span class="legend-color" style="background: #eab308"></span>
          <span>25-50%</span>
        </div>
        <div class="legend-item">
          <span class="legend-color" style="background: #f97316"></span>
          <span>50-75%</span>
        </div>
        <div class="legend-item">
          <span class="legend-color" style="background: #ef4444"></span>
          <span>75%+</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .diagram-container {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--color-bg-canvas, #fafafa);
  }

  .loading,
  .error {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--color-text-muted, #6b7280);
  }

  .error-icon {
    color: #dc2626;
    font-weight: bold;
    font-size: 20px;
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border, #e5e7eb);
    border-top-color: var(--primary, #3b82f6);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .breadcrumb {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--color-bg-elevated, #ffffff);
    border: 1px solid var(--border, #e5e7eb);
    border-radius: 6px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
    z-index: 5;
    font-size: 13px;
  }

  .breadcrumb-back {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    color: var(--color-text-muted, #6b7280);
  }

  .breadcrumb-back:hover {
    background: var(--color-bg, #f3f4f6);
    color: var(--color-text, #111827);
  }

  .breadcrumb-current {
    font-weight: 500;
    color: var(--color-text, #111827);
  }

  .warnings-banner {
    position: absolute;
    top: 16px;
    left: 16px;
    right: 16px;
    padding: 8px 12px;
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 6px;
    color: #92400e;
    font-size: 12px;
    z-index: 5;
  }

  .warning-text {
    display: block;
  }

  .controls {
    position: absolute;
    bottom: 16px;
    right: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 5;
  }

  .layers-panel {
    position: absolute;
    right: 64px;
    bottom: 16px;
    z-index: 6;
    display: grid;
    gap: 8px;
    min-width: 180px;
    padding: 12px;
    color: var(--color-text, #111827);
    background: var(--color-bg-elevated, #ffffff);
    border: 1px solid var(--border, #e5e7eb);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
    font-size: 12px;
  }

  .layers-panel label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }

  .layers-title {
    font-weight: 600;
  }

  .view-presets {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border, #e5e7eb);
  }

  .view-presets button {
    padding: 5px 6px;
    color: var(--color-text-muted, #6b7280);
    background: var(--color-bg, #f3f4f6);
    border: 1px solid transparent;
    border-radius: 5px;
    font-size: 10px;
    cursor: pointer;
  }

  .view-presets button.active {
    color: var(--primary, #2563eb);
    border-color: var(--primary, #2563eb);
    background: color-mix(in srgb, var(--primary, #2563eb) 8%, white);
  }

  .path-panel {
    position: absolute;
    top: 72px;
    right: 64px;
    width: min(420px, calc(100% - 96px));
    padding: 12px;
    background: color-mix(in srgb, var(--color-bg-elevated, #ffffff) 96%, transparent);
    border: 1px solid var(--border, #e5e7eb);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
    z-index: 8;
  }

  .path-panel label {
    display: grid;
    grid-template-columns: 116px 1fr;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    color: var(--color-text-muted, #475569);
    font-size: 11px;
  }

  .path-panel select {
    min-width: 0;
    padding: 6px 8px;
    color: var(--color-text, #0f172a);
    background: var(--color-bg, #ffffff);
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 5px;
    font-size: 11px;
  }

  .path-result {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--border, #e5e7eb);
  }

  .path-hop {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
  }

  .decision {
    padding: 2px 5px;
    color: #ffffff;
    background: #64748b;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 700;
  }

  .decision.allow { background: #16a34a; }
  .decision.block { background: #dc2626; }
  .decision.nat { background: #ea580c; }
  .decision.vpn { background: #7c3aed; }
  .decision.control { background: #8b5cf6; }
  .decision.unknown { background: #64748b; }
  .path-arrow { color: var(--color-text-muted, #64748b); }
  .path-empty {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--border, #e5e7eb);
    color: #64748b;
    font-size: 11px;
    font-weight: 600;
  }

  .control-group {
    display: flex;
    flex-direction: column;
    background: var(--color-bg-elevated, #ffffff);
    border: 1px solid var(--border, #e5e7eb);
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
  }

  .control-group button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--color-text, #111827);
    transition: background 0.15s;
  }

  .control-group button:hover {
    background: var(--color-bg, #f3f4f6);
  }

  .control-group button.active {
    background: var(--primary, #3b82f6);
    color: white;
  }

  .legend {
    position: absolute;
    bottom: 16px;
    left: 16px;
    padding: 8px 12px;
    background: var(--color-bg-elevated, #ffffff);
    border: 1px solid var(--border, #e5e7eb);
    border-radius: 6px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
    z-index: 5;
  }

  .legend-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted, #6b7280);
    margin-bottom: 6px;
  }

  .legend-items {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }

  .legend-color {
    display: inline-block;
    width: 16px;
    height: 3px;
    border-radius: 2px;
  }
</style>
