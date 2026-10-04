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
  import {
    type BlockSpacing,
    darkTheme,
    lightTheme,
    type NetworkGraph,
    type ResolvedLayout,
  } from '@shumoku/core'
  import {
    ArrowCounterClockwiseIcon,
    ArrowLeftIcon,
    CornersOutIcon,
    DatabaseIcon,
    GearSixIcon,
    MagnifyingGlassIcon,
    MagnifyingGlassMinusIcon,
    MagnifyingGlassPlusIcon,
    PathIcon,
    PencilSimpleIcon,
    PlusIcon,
    StackIcon,
  } from 'phosphor-svelte'
  import { onDestroy } from 'svelte'
  import { api } from '$lib/api'
  import {
    HighlightOverlay,
    type HoveredElement,
    NodeStatusOverlay,
    SemanticLayerOverlay,
    TooltipOverlay,
    TopologyViewer,
    WeathermapLinkOverlay,
  } from '$lib/components/topology'
  import { semanticLayers } from '$lib/components/topology/semantic-layers'
  import { createSerialLayoutWriter } from '$lib/components/topology/serial-layout-writer'
  import { serviceIcons } from '$lib/service-icons'
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
  let baseGraph: NetworkGraph | undefined
  let loading = $state(true)
  let error = $state('')
  let layoutSaveError = $state('')
  // Server is baking the layout in the background (large topology). While a
  // previous diagram exists we keep showing it; otherwise the loading state
  // says what's happening instead of a bare spinner.
  let building = $state(false)
  let layoutEdit = $state(false)
  let selectedLayoutNode = $state<string | null>(null)
  let selectedLayoutType = $state<string | null>(null)
  let selectedLayoutLinkId = $state<string | null>(null)
  let selectedLayoutPinIds = $state<string[]>([])
  let pinnedPositions = $state<Record<string, { x: number; y: number }>>({})
  let portSides = $state<Record<string, 'top' | 'bottom' | 'left' | 'right'>>({})
  let portOrders = $state<Record<string, number>>({})
  let portOffsets = $state<Record<string, number>>({})
  let edgeRoutes = $state<Record<string, Array<{ x: number; y: number }>>>({})
  let parentOverrides = $state<Record<string, string | null>>({})
  type OperatorNode = {
    id: string
    label: string[]
    parent?: string
    type: string
    icon?: string
    tenant?: string
    notes?: string
    origin?: 'Manual' | 'NetBox' | 'Existing object'
    reference?: { nodeId: string; nodeName: string }
    binding?: {
      dataSourceId: string
      kind: string
      objectId: string
      objectName: string
    }
  }
  type PresentationOverride = {
    label?: string[]
    type?: string
    icon?: string
  }
  type OperatorLink = {
    id: string
    from: string
    to: string
    label: string
    relationship?: 'network' | 'management' | 'dependency' | 'traffic' | 'documentation'
    direction?: 'none' | 'forward' | 'back' | 'both'
    tenant?: string
    notes?: string
    fromSide: 'top' | 'bottom' | 'left' | 'right'
    toSide: 'top' | 'bottom' | 'left' | 'right'
  }
  type OperatorGroup = {
    id: string
    label: string
    parent?: string
    direction: 'TB' | 'BT' | 'LR' | 'RL'
    tenant?: string
    notes?: string
  }
  let operatorNodes = $state<OperatorNode[]>([])
  let presentationOverrides = $state<Record<string, PresentationOverride>>({})
  let operatorLinks = $state<OperatorLink[]>([])
  let operatorGroups = $state<OperatorGroup[]>([])
  type LinkAppearance = {
    color: string
    width: number
    preset: 'solid' | 'dashed' | 'dotted' | 'dash-dot' | 'long-dash' | 'double'
    routeShape: 'straight' | 'bent'
    routePolicy: 'avoid' | 'under'
  }
  const strokePresets = [
    { id: 'solid', label: 'Solid', dash: '' },
    { id: 'dashed', label: 'Dashed', dash: '8 5' },
    { id: 'dotted', label: 'Dotted', dash: '1 5' },
    { id: 'dash-dot', label: 'Dash-dot', dash: '10 4 2 4' },
    { id: 'long-dash', label: 'Long dashes', dash: '16 6' },
    { id: 'double', label: 'Double', dash: '' },
  ] as const
  type LinkPorts = { from?: string; to?: string }
  type LinkContinuation = {
    enabled: boolean
    label: string
    length?: number
    source?: { x: number; y: number }
    destination?: { x: number; y: number }
  }
  type PortPresentation = { label?: string; description?: string }
  const defaultBlockSpacing: BlockSpacing = { top: 20, right: 20, bottom: 20, left: 20 }
  let blockSpacingOverrides = $state<Record<string, BlockSpacing>>({})
  let linkAppearanceOverrides = $state<Record<string, LinkAppearance>>({})
  let linkPortOverrides = $state<Record<string, LinkPorts>>({})
  let linkContinuationOverrides = $state<Record<string, LinkContinuation>>({})
  let portPresentationOverrides = $state<Record<string, PortPresentation>>({})
  let portEditorOpen = $state(false)
  let portDraft = $state<{
    nodeId: string
    portId: string
    label: string
    description: string
  } | null>(null)
  let appearanceEditorOpen = $state(false)
  let appearanceDraft = $state<
    | (LinkAppearance &
        LinkPorts & {
          id: string
          continuationEnabled: boolean
          continuationLabel: string
          continuationLength: number
        })
    | null
  >(null)
  let appearanceDraftError = $state('')
  let objectEditorOpen = $state(false)
  let objectDraft = $state<OperatorNode | null>(null)
  let objectSource = $state<'Manual' | 'NetBox' | 'Existing object'>('Manual')
  let iconQuery = $state('')
  let iconImportUrl = $state('')
  let iconImportError = $state('')
  let bindingSources = $state<Array<{ id: string; name: string }>>([])
  let bindingSourceId = $state('')
  let bindingKind = $state('virtual-machine')
  let bindingQuery = $state('')
  let bindingResults = $state<Array<{ id: string; kind: string; name: string; label: string[] }>>(
    [],
  )
  let bindingLoading = $state(false)
  let bindingError = $state('')
  let linkEditorOpen = $state(false)
  let linkDraft = $state<OperatorLink | null>(null)
  let linkDraftError = $state('')
  const editorLink = $derived(graph?.links.find((link) => link.id === appearanceDraft?.id))
  const editorSourceId = $derived(
    appearanceEditorOpen ? editorLink?.from.node : linkEditorOpen ? linkDraft?.from : undefined,
  )
  const editorDestinationId = $derived(
    appearanceEditorOpen ? editorLink?.to.node : linkEditorOpen ? linkDraft?.to : undefined,
  )
  const editorSourceVisualId = $derived(
    graph?.nodes.find((node) => node.id === editorSourceId)?.metadata?.['presentationRole'] ===
      'subgraph-boundary-port'
      ? (graph?.nodes.find((node) => node.id === editorSourceId)?.parent ?? editorSourceId)
      : editorSourceId,
  )
  const editorDestinationVisualId = $derived(
    graph?.nodes.find((node) => node.id === editorDestinationId)?.metadata?.['presentationRole'] ===
      'subgraph-boundary-port'
      ? (graph?.nodes.find((node) => node.id === editorDestinationId)?.parent ??
          editorDestinationId)
      : editorDestinationId,
  )
  let groupEditorOpen = $state(false)
  let groupDraft = $state<OperatorGroup | null>(null)
  let groupManagerOpen = $state(false)
  let layersOpen = $state(false)
  let nodeDetailsVisible = $state(true)
  let portLabelsVisible = $state(true)
  let linkLabelsVisible = $state(true)
  let operatorObjectsVisible = $state(true)
  let semanticHiddenLayers = $state<string[]>([])
  let pathExplorerOpen = $state(false)
  let dataHealthOpen = $state(false)
  let pathSourceId = $state('')
  let pathDestinationId = $state('')
  let pathFlowId = $state('')
  let flowEditorOpen = $state(false)
  let customTrafficFlows = $state<TrafficFlowProfile[]>([])
  let flowDraft = $state<TrafficFlowProfile | null>(null)

  type PathHop = { linkId: string; label: string; decision: string }
  type TrafficPath = { nodeIds: string[]; hops: PathHop[] }
  type TrafficFlowProfile = {
    id: string
    label: string
    source: string
    destination: string
    enabled?: boolean
    primaryColor?: string
    controlColor?: string
    primaryLinkIds?: string[]
    controlLinkIds?: string[]
  }

  const flowSettingsKey = $derived(`topology-flow-profiles-${topologyId}`)

  async function loadCustomTrafficFlows() {
    if (!topologyId || readOnly) return
    try {
      const saved = await api.settings.getValue(flowSettingsKey)
      const parsed = JSON.parse(saved.value)
      customTrafficFlows = Array.isArray(parsed) ? parsed : []
    } catch {
      customTrafficFlows = []
    }
  }

  async function saveCustomTrafficFlows(next: TrafficFlowProfile[]) {
    customTrafficFlows = next
    if (topologyId && !readOnly) await api.settings.setValue(flowSettingsKey, JSON.stringify(next))
  }

  function newFlowDraft() {
    flowDraft = {
      id: `flow-${Date.now()}`,
      label: 'New traffic flow',
      source: pathSourceId,
      destination: pathDestinationId,
      enabled: true,
      primaryColor: '#2563eb',
      controlColor: '#8b5cf6',
      primaryLinkIds: [],
      controlLinkIds: [],
    }
  }

  function editFlowDraft(flow: TrafficFlowProfile) {
    flowDraft = {
      ...flow,
      primaryLinkIds: [...(flow.primaryLinkIds ?? [])],
      controlLinkIds: [...(flow.controlLinkIds ?? [])],
    }
  }

  async function commitFlowDraft() {
    if (!flowDraft?.label.trim() || !flowDraft.source || !flowDraft.destination) return
    const next = [...customTrafficFlows]
    const index = next.findIndex((flow) => flow.id === flowDraft?.id)
    if (index >= 0) next[index] = { ...flowDraft, label: flowDraft.label.trim() }
    else next.push({ ...flowDraft, label: flowDraft.label.trim() })
    await saveCustomTrafficFlows(next)
    pathFlowId = flowDraft.id
    selectTrafficFlow(flowDraft.id)
    flowDraft = null
  }

  async function deleteCustomFlow(id: string) {
    await saveCustomTrafficFlows(customTrafficFlows.filter((flow) => flow.id !== id))
    if (pathFlowId === id) pathFlowId = ''
    if (flowDraft?.id === id) flowDraft = null
  }

  async function moveCustomFlow(id: string, delta: number) {
    const next = [...customTrafficFlows]
    const index = next.findIndex((flow) => flow.id === id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    await saveCustomTrafficFlows(next)
  }

  async function toggleCustomFlow(flow: TrafficFlowProfile) {
    await saveCustomTrafficFlows(
      customTrafficFlows.map((item) =>
        item.id === flow.id ? { ...item, enabled: item.enabled === false } : item,
      ),
    )
  }

  async function duplicateCustomFlow(flow: TrafficFlowProfile) {
    await saveCustomTrafficFlows([
      ...customTrafficFlows,
      { ...flow, id: `flow-${Date.now()}`, label: `${flow.label} copy` },
    ])
  }

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

  function trafficHopLabel(link: Record<string, unknown>): string {
    const metadata = (link.metadata ?? {}) as Record<string, unknown>
    return String(metadata.pathLabel ?? link.label ?? '').trim() || 'unlabelled connection'
  }

  function findTrafficPath(requiredService = 'any'): TrafficPath | null {
    if (!graph || !pathSourceId || !pathDestinationId || pathSourceId === pathDestinationId)
      return null
    const sourceLabel = nodeLabel(
      graph.nodes.find((node) => node.id === pathSourceId),
    ).toLowerCase()
    const kerioAccessPath =
      sourceLabel.includes('remote vpn users') || sourceLabel.includes('kerio')
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
      if (arrow !== 'reverse')
        adjacency.set(from, [...(adjacency.get(from) ?? []), { nodeId: to, link: item }])
      if (arrow !== 'forward')
        adjacency.set(to, [...(adjacency.get(to) ?? []), { nodeId: from, link: item }])
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
      const current = queue.shift()
      if (!current) break
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
        label: trafficHopLabel(step.link),
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
        String(
          (node as unknown as { metadata?: { logicalId?: string } }).metadata?.logicalId ?? node.id,
        ),
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
    const profiles = [...(metadata?.trafficFlows ?? []), ...nodeFlows].filter(
      (item): item is TrafficFlowProfile => {
        const flow = item as Partial<TrafficFlowProfile>
        return Boolean(flow.id && flow.label && flow.source && flow.destination)
      },
    )
    return [...new Map(profiles.map((flow) => [flow.id, flow])).values()]
  })
  const editableTrafficFlows = $derived.by(() => {
    const customIds = new Set(customTrafficFlows.map((flow) => flow.id))
    return [...customTrafficFlows, ...trafficFlowProfiles.filter((flow) => !customIds.has(flow.id))]
  })
  const availableTrafficFlows = $derived(
    editableTrafficFlows.filter((flow) => flow.enabled !== false),
  )

  $effect(() => {
    if (!pathFlowId) return
    const selected = availableTrafficFlows.find((flow) => flow.id === pathFlowId)
    if (!selected) pathFlowId = ''
  })

  function selectTrafficFlow(flowId: string) {
    const selected = availableTrafficFlows.find((flow) => flow.id === flowId)
    if (!selected) {
      pathFlowId = ''
      return
    }
    pathSourceId = selected.source
    pathDestinationId = selected.destination
    pathFlowId = flowId
  }

  function flowLinkLabel(link: (typeof graph.links)[number]) {
    const from = nodeLabel(graph.nodes.find((node) => node.id === link.from.node)) || link.from.node
    const to = nodeLabel(graph.nodes.find((node) => node.id === link.to.node)) || link.to.node
    const label = String(link.label || '').trim()
    return `${from} → ${to}${label ? ` · ${label}` : ''}`
  }

  const selectedTrafficFlow = $derived(availableTrafficFlows.find((flow) => flow.id === pathFlowId))
  const trafficPath = $derived.by<TrafficPath | null>(() => {
    const explicitIds = selectedTrafficFlow?.primaryLinkIds ?? []
    if (!graph || explicitIds.length === 0) return findTrafficPath()
    const nodeIds = new Set<string>()
    const hops: PathHop[] = []
    for (const id of explicitIds) {
      const link = graph.links.find((item) => item.id === id)
      if (!link) continue
      nodeIds.add(link.from.node)
      nodeIds.add(link.to.node)
      hops.push({
        linkId: link.id,
        label: trafficHopLabel(link as unknown as Record<string, unknown>),
        decision: trafficDecision(link as unknown as Record<string, unknown>),
      })
    }
    return hops.length > 0 ? { nodeIds: [...nodeIds], hops } : findTrafficPath()
  })

  const highlightedPathNodes = $derived(new Set(trafficPath?.nodeIds ?? []))
  const highlightedPathLinks = $derived(new Set(trafficPath?.hops.map((hop) => hop.linkId) ?? []))
  const controlPlanePath = $derived.by(() => {
    const nodeIds = new Set<string>()
    const linkIds = new Set<string>()
    if (selectedTrafficFlow?.controlLinkIds?.length) {
      for (const id of selectedTrafficFlow.controlLinkIds) {
        const link = graph?.links.find((item) => item.id === id)
        if (!link) continue
        linkIds.add(id)
        nodeIds.add(link.from.node)
        nodeIds.add(link.to.node)
      }
      return { nodeIds, linkIds }
    }
    const sourceLabel = nodeLabel(
      graph?.nodes.find((node) => node.id === pathSourceId),
    ).toLowerCase()
    if (!graph || !sourceLabel.includes('netbird')) return { nodeIds, linkIds }
    for (const rawLink of graph.links) {
      const item = rawLink as unknown as Record<string, unknown>
      if (
        String(item.label ?? '')
          .trim()
          .toLowerCase() !== 'control'
      )
        continue
      const from = String((item.from as { node?: string })?.node ?? '')
      const to = String((item.to as { node?: string })?.node ?? '')
      if (from) nodeIds.add(from)
      if (to) nodeIds.add(to)
      linkIds.add(String(item.id ?? ''))
    }
    return { nodeIds, linkIds }
  })
  const dataFreshness = $derived.by(() => {
    const entries = new Map<string, number>()
    for (const node of graph?.nodes ?? []) {
      const metadata = (node as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}
      if (!Array.isArray(metadata.freshness)) continue
      for (const raw of metadata.freshness) {
        const item = raw as { source?: unknown; observedAt?: unknown }
        const source = String(item.source ?? '')
        const observedAt = Number(item.observedAt ?? 0)
        if (source && observedAt && observedAt > (entries.get(source) ?? 0))
          entries.set(source, observedAt)
      }
    }
    return [...entries.entries()].map(([source, observedAt]) => ({ source, observedAt }))
  })
  const reconciliationIssues = $derived.by(() => {
    const issues: Array<{
      nodeId: string
      node: string
      field: string
      status: string
      netbox: string
      observed: string
    }> = []
    for (const node of graph?.nodes ?? []) {
      const metadata = (node as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}
      if (!Array.isArray(metadata.comparisons)) continue
      for (const raw of metadata.comparisons) {
        const comparison = raw as Record<string, unknown>
        const status = String(comparison.status ?? 'unknown')
        if (status === 'match' || status === 'confirmed') continue
        issues.push({
          nodeId: node.id,
          node: nodeLabel(node),
          field: String(comparison.field ?? 'source data'),
          status,
          netbox: String(comparison.netbox ?? '—'),
          observed: String(comparison.observed ?? '—'),
        })
      }
    }
    return issues
  })

  function inspectReconciliationIssue(nodeId: string) {
    dataHealthOpen = false
    viewer?.panToNode(nodeId)
    handleSelect(nodeId, 'node')
  }

  type OperatorLayout = {
    nodePositions: Record<string, { x: number; y: number }>
    portSides: Record<string, 'top' | 'bottom' | 'left' | 'right'>
    portOrders: Record<string, number>
    portOffsets: Record<string, number>
    edgeRoutes: Record<string, Array<{ x: number; y: number }>>
    parentOverrides?: Record<string, string | null>
    operatorNodes?: OperatorNode[]
    presentationOverrides?: Record<string, PresentationOverride>
    operatorLinks?: OperatorLink[]
    operatorGroups?: OperatorGroup[]
    blockSpacingOverrides?: Record<string, BlockSpacing>
    linkAppearanceOverrides?: Record<string, LinkAppearance>
    linkPortOverrides?: Record<string, LinkPorts>
    linkContinuationOverrides?: Record<string, LinkContinuation>
    portPresentationOverrides?: Record<string, PortPresentation>
  }

  const pinStorageKey = $derived(`shumoku-layout-pins:${topologyId}`)
  const portStorageKey = $derived(`shumoku-layout-port-sides:${topologyId}`)
  const layerStorageKey = $derived(`shumoku-view-layers:${topologyId}`)
  const availableSemanticLayers = $derived(semanticLayers(graph))
  const hiddenSemanticLayerSet = $derived(new Set(semanticHiddenLayers))

  function loadLayerPreferences() {
    if (typeof localStorage === 'undefined' || !topologyId) return
    try {
      const saved = JSON.parse(localStorage.getItem(layerStorageKey) ?? '{}')
      nodeDetailsVisible = saved.nodeDetails ?? true
      portLabelsVisible = saved.portLabels ?? true
      linkLabelsVisible = saved.linkLabels ?? true
      operatorObjectsVisible = saved.operatorObjects ?? true
      semanticHiddenLayers = Array.isArray(saved.semanticHiddenLayers)
        ? saved.semanticHiddenLayers.filter(
            (item: unknown): item is string => typeof item === 'string',
          )
        : []
    } catch {
      nodeDetailsVisible = true
      portLabelsVisible = true
      linkLabelsVisible = true
      operatorObjectsVisible = true
      semanticHiddenLayers = []
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
        operatorObjects: operatorObjectsVisible,
        semanticHiddenLayers,
      }),
    )
  }

  function setLayer(
    layer: 'nodeDetails' | 'portLabels' | 'linkLabels' | 'operatorObjects',
    enabled: boolean,
  ) {
    if (layer === 'nodeDetails') nodeDetailsVisible = enabled
    if (layer === 'portLabels') portLabelsVisible = enabled
    if (layer === 'linkLabels') linkLabelsVisible = enabled
    if (layer === 'operatorObjects') operatorObjectsVisible = enabled
    saveLayerPreferences()
  }

  function setSemanticLayer(layer: string, enabled: boolean) {
    semanticHiddenLayers = enabled
      ? semanticHiddenLayers.filter((item) => item !== layer)
      : [...new Set([...semanticHiddenLayers, layer])]
    saveLayerPreferences()
  }

  const visibleGraph = $derived.by<NetworkGraph | undefined>(() => {
    if (!graph || operatorObjectsVisible) return graph
    const hiddenNodes = new Set(
      graph.nodes
        .filter((node) =>
          Boolean((node.metadata as Record<string, unknown> | undefined)?.operatorObject),
        )
        .map((node) => node.id),
    )
    const hiddenGroups = new Set(
      (graph.subgraphs ?? [])
        .filter((group) =>
          Boolean((group.metadata as Record<string, unknown> | undefined)?.operatorObject),
        )
        .map((group) => group.id),
    )
    return {
      ...graph,
      nodes: graph.nodes
        .filter((node) => !hiddenNodes.has(node.id))
        .map((node) =>
          hiddenGroups.has(node.parent ?? '') ? { ...node, parent: undefined } : node,
        ),
      links: graph.links.filter(
        (link) =>
          !(link.metadata as Record<string, unknown> | undefined)?.operatorObject &&
          !hiddenNodes.has(link.from.node) &&
          !hiddenNodes.has(link.to.node),
      ),
      subgraphs: (graph.subgraphs ?? [])
        .filter((group) => !hiddenGroups.has(group.id))
        .map((group) =>
          hiddenGroups.has(group.parent ?? '') ? { ...group, parent: undefined } : group,
        ),
    }
  })

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

  const layoutWriter = createSerialLayoutWriter(
    ({ id, operatorLayout }: { id: string; operatorLayout: OperatorLayout }) =>
      api.topologies.displaySettings.set(id, { operatorLayout }),
  )

  async function persistOperatorLayout(
    nodePositions: Record<string, { x: number; y: number }>,
    sides: Record<string, 'top' | 'bottom' | 'left' | 'right'>,
    orders: Record<string, number>,
    offsets: Record<string, number>,
    routes: Record<string, Array<{ x: number; y: number }>>,
    parents: Record<string, string | null> = parentOverrides,
    manualNodes: OperatorNode[] = operatorNodes,
    overrides: Record<string, PresentationOverride> = presentationOverrides,
    manualLinks: OperatorLink[] = operatorLinks,
    manualGroups: OperatorGroup[] = operatorGroups,
    spacing: Record<string, BlockSpacing> = blockSpacingOverrides,
    appearances: Record<string, LinkAppearance> = linkAppearanceOverrides,
    linkPorts: Record<string, LinkPorts> = linkPortOverrides,
    portPresentations: Record<string, PortPresentation> = portPresentationOverrides,
    continuations: Record<string, LinkContinuation> = linkContinuationOverrides,
  ) {
    if (!topologyId || readOnly) return
    const id = topologyId
    // Capture a plain snapshot now: later Svelte edits must not mutate a queued write.
    const operatorLayout = JSON.parse(
      JSON.stringify({
        nodePositions,
        portSides: sides,
        portOrders: orders,
        portOffsets: offsets,
        edgeRoutes: routes,
        parentOverrides: parents,
        operatorNodes: manualNodes,
        presentationOverrides: overrides,
        operatorLinks: manualLinks,
        operatorGroups: manualGroups,
        blockSpacingOverrides: spacing,
        linkAppearanceOverrides: appearances,
        linkPortOverrides: linkPorts,
        linkContinuationOverrides: continuations,
        portPresentationOverrides: portPresentations,
      }),
    ) as OperatorLayout
    try {
      await layoutWriter.enqueue({ id, operatorLayout })
      layoutSaveError = ''
    } catch (cause) {
      layoutSaveError = cause instanceof Error ? cause.message : 'Layout could not be saved'
    }
  }

  function applyLinkPresentation<T extends NetworkGraph['links'][number]>(
    link: T,
    appearances: Record<string, LinkAppearance>,
    linkPorts: Record<string, LinkPorts>,
    continuations: Record<string, LinkContinuation>,
  ): T {
    const id = link.id ?? ''
    const ports = linkPorts[id]
    const appearance = appearances[id]
    const continuation = continuations[id]
    const dash =
      appearance?.preset === 'dashed'
        ? '8 5'
        : appearance?.preset === 'dotted'
          ? '1 5'
          : appearance?.preset === 'dash-dot'
            ? '10 4 2 4'
            : appearance?.preset === 'long-dash'
              ? '16 6'
              : ''
    return {
      ...link,
      ...(ports?.from ? { from: { ...link.from, port: ports.from } } : {}),
      ...(ports?.to ? { to: { ...link.to, port: ports.to } } : {}),
      ...(appearance
        ? {
            type: appearance.preset === 'double' ? ('double' as const) : ('solid' as const),
            style: {
              ...link.style,
              stroke: appearance.color,
              strokeWidth: appearance.width,
              strokeDasharray: dash,
            },
          }
        : {}),
      ...(appearance || continuation
        ? {
            metadata: {
              ...link.metadata,
              ...(appearance
                ? {
                    routePolicy: appearance.routePolicy,
                    routeShape: appearance.routeShape ?? 'bent',
                  }
                : {}),
              ...(continuation ? { continuation } : {}),
            },
          }
        : {}),
    } as T
  }

  function applyLayoutOverrides(
    source: NetworkGraph,
    pins: Record<string, { x: number; y: number }>,
    sides: Record<string, 'top' | 'bottom' | 'left' | 'right'>,
    orders: Record<string, number> = portOrders,
    offsets: Record<string, number> = portOffsets,
    parents: Record<string, string | null> = parentOverrides,
    manualNodes: OperatorNode[] = operatorNodes,
    overrides: Record<string, PresentationOverride> = presentationOverrides,
    manualLinks: OperatorLink[] = operatorLinks,
    manualGroups: OperatorGroup[] = operatorGroups,
    spacing: Record<string, BlockSpacing> = blockSpacingOverrides,
    appearances: Record<string, LinkAppearance> = linkAppearanceOverrides,
    linkPorts: Record<string, LinkPorts> = linkPortOverrides,
    portPresentations: Record<string, PortPresentation> = portPresentationOverrides,
    continuations: Record<string, LinkContinuation> = linkContinuationOverrides,
  ): NetworkGraph {
    const mergedNodes: NetworkGraph['nodes'] = [
      ...source.nodes,
      ...manualNodes
        .filter((manual) => !source.nodes.some((node) => node.id === manual.id))
        .map((manual) => ({
          id: manual.id,
          label: manual.label,
          parent: manual.parent,
          spec: {
            kind: 'hardware' as const,
            type: manual.type,
            ...(manual.icon ? { icon: manual.icon } : {}),
          },
          style: { strokeDasharray: '6 4' },
          metadata: {
            operatorObject: true,
            source: 'operator',
            origin:
              manual.origin ??
              (manual.binding ? 'NetBox' : manual.reference ? 'Existing object' : 'Manual'),
            tenant: manual.tenant,
            annotations: manual.notes,
            binding: manual.binding,
          },
        })),
    ]
    const operatorPorts = new Map<
      string,
      Array<{
        id: string
        label: string
        connectors: never[]
        placement: { side: 'top' | 'bottom' | 'left' | 'right'; order: number }
      }>
    >()
    for (const link of manualLinks) {
      const fromPorts = operatorPorts.get(link.from) ?? []
      fromPorts.push({
        id: `${link.id}:from`,
        label: link.label,
        connectors: [],
        placement: { side: link.fromSide, order: fromPorts.length },
      })
      operatorPorts.set(link.from, fromPorts)
      const toPorts = operatorPorts.get(link.to) ?? []
      toPorts.push({
        id: `${link.id}:to`,
        label: link.label,
        connectors: [],
        placement: { side: link.toSide, order: toPorts.length },
      })
      operatorPorts.set(link.to, toPorts)
    }
    const mergedSubgraphs: NonNullable<NetworkGraph['subgraphs']> = [
      ...(source.subgraphs ?? []),
      ...manualGroups
        .filter((manual) => !(source.subgraphs ?? []).some((group) => group.id === manual.id))
        .map((manual, index) => ({
          id: manual.id,
          label: manual.label,
          parent: manual.parent,
          direction: manual.direction,
          // Empty groups have no child hull for the layout engine to measure.
          // Keep a small selectable canvas area until an object is placed in it.
          bounds: {
            x: 80 + (index % 3) * 280,
            y: 80 + Math.floor(index / 3) * 180,
            width: 240,
            height: 140,
          },
          metadata: {
            operatorObject: true,
            source: 'operator',
            origin: 'Manual',
            tenant: manual.tenant,
            annotations: manual.notes,
          },
        })),
    ]
    // A group is also a connection-capable block. Give every container that
    // lacks a real boundary interface one stable point on its outline.
    const groupParents = new Map(mergedSubgraphs.map((group) => [group.id, group.parent]))
    const belongsToGroup = (parent: string | undefined, groupId: string): boolean => {
      const seen = new Set<string>()
      while (parent && !seen.has(parent)) {
        if (parent === groupId) return true
        seen.add(parent)
        parent = groupParents.get(parent)
      }
      return false
    }
    const groupBoundaryNodes: NetworkGraph['nodes'] = mergedSubgraphs
      .filter(
        (group) =>
          !mergedNodes.some(
            (node) =>
              node.parent === group.id &&
              node.metadata?.['presentationRole'] === 'subgraph-boundary-port',
          ),
      )
      .map((group) => {
        const positions = mergedNodes
          .filter((node) => belongsToGroup(node.parent, group.id))
          .flatMap((node) => (node.position ? [node.position] : []))
        const position = positions.length
          ? {
              x: positions.reduce((sum, point) => sum + point.x, 0) / positions.length,
              y: positions.reduce((sum, point) => sum + point.y, 0) / positions.length,
            }
          : {
              x: (group.bounds?.x ?? 0) + (group.bounds?.width ?? 0) / 2,
              y: (group.bounds?.y ?? 0) + (group.bounds?.height ?? 0) / 2,
            }
        return {
          id: `operator-group-boundary:${group.id}`,
          label: [group.label],
          parent: group.id,
          position,
          metadata: { presentationRole: 'subgraph-boundary-port', source: 'operator' },
          ports: [
            {
              id: 'anchor',
              label: '',
              connectors: [],
              placement: { side: 'left', offset: 0.5 },
            },
          ],
        }
      })
    const nodesWithBoundaries = [...mergedNodes, ...groupBoundaryNodes]
    const validNodeIds = new Set(nodesWithBoundaries.map((node) => node.id))
    return {
      ...source,
      nodes: nodesWithBoundaries.map((node) => {
        const manual = manualNodes.find((candidate) => candidate.id === node.id)
        return {
          ...node,
          ...(manual
            ? {
                label: manual.label,
                parent: manual.parent,
                spec: {
                  kind: 'hardware' as const,
                  type: manual.type,
                  ...(manual.icon ? { icon: manual.icon } : {}),
                },
              }
            : {}),
          ...(overrides[node.id]?.label ? { label: overrides[node.id].label } : {}),
          ...(overrides[node.id]?.type || overrides[node.id]?.icon
            ? {
                spec: {
                  ...node.spec,
                  ...(overrides[node.id]?.type
                    ? { kind: 'hardware' as const, type: overrides[node.id].type }
                    : {}),
                  ...(overrides[node.id]?.icon ? { icon: overrides[node.id].icon } : {}),
                },
              }
            : {}),
          ...(Object.hasOwn(parents, node.id) ? { parent: parents[node.id] ?? undefined } : {}),
          ...(pins[node.id] ? { position: pins[node.id] } : {}),
          style: {
            ...node.style,
            outerSpacing: {
              ...defaultBlockSpacing,
              ...node.style?.outerSpacing,
              ...spacing[node.id],
            },
          },
          ports: [
            ...(node.ports ?? []).filter((port) => !port.id.startsWith('operator-link-')),
            ...(operatorPorts.get(node.id) ?? []),
            ...(!node.ports?.length && !operatorPorts.has(node.id)
              ? [
                  {
                    id: 'operator-anchor',
                    label: '',
                    connectors: [],
                    placement: { side: 'left' as const, offset: 0.5 },
                  },
                ]
              : []),
          ].map((port) => {
            const side = sides[`${node.id}:${port.id}`]
            const order = orders[`${node.id}:${port.id}`]
            const offset = offsets[`${node.id}:${port.id}`]
            const presentation = portPresentations[`${node.id}:${port.id}`]
            return {
              ...port,
              ...(presentation?.label !== undefined ? { label: presentation.label } : {}),
              ...(presentation?.description !== undefined
                ? { notes: presentation.description }
                : {}),
              ...(side || order !== undefined || offset !== undefined
                ? {
                    placement: {
                      ...port.placement,
                      ...(side ? { side } : {}),
                      ...(order !== undefined ? { order } : {}),
                      ...(offset !== undefined ? { offset } : {}),
                    },
                  }
                : {}),
            }
          }),
        }
      }),
      links: [
        ...source.links
          .filter((link) => !(link.metadata as Record<string, unknown> | undefined)?.operatorObject)
          .map((link) => applyLinkPresentation(link, appearances, linkPorts, continuations)),
        ...manualLinks
          .filter((link) => validNodeIds.has(link.from) && validNodeIds.has(link.to))
          .map((link) =>
            applyLinkPresentation(
              {
                id: link.id,
                from: { node: link.from, port: `${link.id}:from` },
                to: { node: link.to, port: `${link.id}:to` },
                label: link.label,
                arrow: link.direction ?? 'forward',
                metadata: {
                  operatorObject: true,
                  source: 'operator',
                  relationship: link.relationship ?? 'network',
                  direction: link.direction ?? 'forward',
                  origin: 'Manual',
                  tenant: link.tenant,
                  annotations: link.notes,
                },
              },
              appearances,
              linkPorts,
              continuations,
            ),
          ),
      ],
      subgraphs: mergedSubgraphs.map((subgraph) => ({
        ...subgraph,
        style: {
          ...subgraph.style,
          outerSpacing: {
            ...defaultBlockSpacing,
            ...subgraph.style?.outerSpacing,
            ...spacing[subgraph.id],
          },
        },
        ...(Object.hasOwn(parents, subgraph.id)
          ? { parent: parents[subgraph.id] ?? undefined }
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
      // A refresh must never restore a server copy older than the last edit.
      await layoutWriter.flush().catch(() => undefined)
      loadLayerPreferences()
      const loader = graphLoader ?? (() => api.topologies.getView(topologyId))
      const [res, display] = await Promise.all([
        loader(),
        readOnly || !topologyId
          ? Promise.resolve(null)
          : api.topologies.displaySettings.get(topologyId),
      ])
      await loadCustomTrafficFlows()
      if (res.deriving) {
        building = true
        loading = !hasGraph
        scheduleRefresh(3000)
        return
      }
      if (res.graph) {
        baseGraph = res.graph
        const saved = (display as { operatorLayout?: OperatorLayout } | null)?.operatorLayout
        const localPins = readPins()
        const localSides = readPortSides()
        const serverHasLayout =
          saved &&
          (Object.keys(saved.nodePositions).length > 0 ||
            Object.keys(saved.portSides).length > 0 ||
            Object.keys(saved.portOrders ?? {}).length > 0 ||
            Object.keys(saved.portOffsets ?? {}).length > 0 ||
            Object.keys(saved.edgeRoutes ?? {}).length > 0 ||
            Object.keys(saved.parentOverrides ?? {}).length > 0 ||
            (saved.operatorNodes?.length ?? 0) > 0 ||
            Object.keys(saved.presentationOverrides ?? {}).length > 0 ||
            (saved.operatorLinks?.length ?? 0) > 0 ||
            (saved.operatorGroups?.length ?? 0) > 0 ||
            Object.keys(saved.blockSpacingOverrides ?? {}).length > 0 ||
            Object.keys(saved.linkAppearanceOverrides ?? {}).length > 0 ||
            Object.keys(saved.linkPortOverrides ?? {}).length > 0 ||
            Object.keys(saved.linkContinuationOverrides ?? {}).length > 0 ||
            Object.keys(saved.portPresentationOverrides ?? {}).length > 0)
        const pins = serverHasLayout ? saved.nodePositions : localPins
        const sides = serverHasLayout ? saved.portSides : localSides
        const orders = serverHasLayout ? (saved.portOrders ?? {}) : {}
        const offsets = serverHasLayout ? (saved.portOffsets ?? {}) : {}
        const parents = saved?.parentOverrides ?? {}
        const manualNodes = await refreshBoundNodes(saved?.operatorNodes ?? [])
        const overrides = saved?.presentationOverrides ?? {}
        const manualLinks = saved?.operatorLinks ?? []
        const manualGroups = saved?.operatorGroups ?? []
        const spacing = saved?.blockSpacingOverrides ?? {}
        const appearances = saved?.linkAppearanceOverrides ?? {}
        const linkPorts = saved?.linkPortOverrides ?? {}
        const continuations = saved?.linkContinuationOverrides ?? {}
        const portPresentations = saved?.portPresentationOverrides ?? {}
        edgeRoutes = saved?.edgeRoutes ?? {}
        pinnedPositions = pins
        portSides = sides
        portOrders = orders
        portOffsets = offsets
        parentOverrides = parents
        operatorNodes = manualNodes
        presentationOverrides = overrides
        operatorLinks = manualLinks
        operatorGroups = manualGroups
        blockSpacingOverrides = spacing
        linkAppearanceOverrides = appearances
        linkPortOverrides = linkPorts
        linkContinuationOverrides = continuations
        portPresentationOverrides = portPresentations
        if (
          !serverHasLayout &&
          (Object.keys(localPins).length > 0 || Object.keys(localSides).length > 0)
        ) {
          void persistOperatorLayout(localPins, localSides, {}, {}, {})
        }
        graph = applyLayoutOverrides(
          res.graph,
          pins,
          sides,
          orders,
          offsets,
          parents,
          manualNodes,
          overrides,
          manualLinks,
          manualGroups,
          spacing,
          appearances,
          linkPorts,
          portPresentations,
          continuations,
        )
        // Pinned positions require a fresh client layout so ports and routes
        // are recalculated around the operator's saved placement.
        // The shared default spacing and visible fallback points change every
        // resolved hull; the server snapshot does not contain those edits.
        serverLayout = undefined
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
      selectedLayoutType = type
      if (type === 'port' && id) startEditPort(id)
      else portEditorOpen = false
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

  function startEditPort(resolvedId: string) {
    const node = graph?.nodes.find((candidate) =>
      candidate.ports?.some((port) => `${candidate.id}:${port.id}` === resolvedId),
    )
    const port = node?.ports?.find((candidate) => `${node.id}:${candidate.id}` === resolvedId)
    if (!node || !port) return
    portDraft = {
      nodeId: node.id,
      portId: port.id,
      label: port.label,
      description: portPresentationOverrides[resolvedId]?.description ?? port.notes ?? '',
    }
    portEditorOpen = true
  }

  function savePortDraft() {
    if (!graph || !portDraft) return
    const key = `${portDraft.nodeId}:${portDraft.portId}`
    portPresentationOverrides = {
      ...portPresentationOverrides,
      [key]: { label: portDraft.label.trim(), description: portDraft.description.trim() },
    }
    void persistOperatorLayout(pinnedPositions, portSides, portOrders, portOffsets, edgeRoutes)
    graph = applyLayoutOverrides(
      baseGraph ?? graph,
      pinnedPositions,
      portSides,
      portOrders,
      portOffsets,
    )
    serverLayout = undefined
    portEditorOpen = false
    portDraft = null
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
    selectedLayoutType = null
    selectedLayoutPinIds = []
    void loadGraph()
  }

  async function resetOperatorLayout() {
    edgeRoutes = {}
    portOrders = {}
    portOffsets = {}
    parentOverrides = {}
    pinnedPositions = {}
    portSides = {}
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(pinStorageKey)
      localStorage.removeItem(portStorageKey)
    }
    selectedLayoutNode = null
    selectedLayoutType = null
    selectedLayoutLinkId = null
    selectedLayoutPinIds = []
    await persistOperatorLayout({}, {}, {}, {}, {})
    if (!layoutSaveError) await loadGraph()
  }

  function isSubgraphDescendant(candidateId: string, ancestorId: string): boolean {
    if (!graph) return false
    const parents = new Map(
      (graph.subgraphs ?? []).map((subgraph) => [
        subgraph.id,
        Object.hasOwn(parentOverrides, subgraph.id)
          ? (parentOverrides[subgraph.id] ?? undefined)
          : subgraph.parent,
      ]),
    )
    let parent = parents.get(candidateId)
    while (parent) {
      if (parent === ancestorId) return true
      parent = parents.get(parent)
    }
    return false
  }

  function availableParentsFor(id: string) {
    return (graph?.subgraphs ?? []).filter(
      (candidate) => candidate.id !== id && !isSubgraphDescendant(candidate.id, id),
    )
  }

  function effectiveParent(id: string): string {
    if (Object.hasOwn(parentOverrides, id)) return parentOverrides[id] ?? ''
    const node = graph?.nodes.find((candidate) => candidate.id === id)
    if (node) return node.parent ?? ''
    return graph?.subgraphs?.find((candidate) => candidate.id === id)?.parent ?? ''
  }

  function changeSelectedParent(parent: string) {
    if (!graph || !selectedLayoutNode || !['node', 'subgraph'].includes(selectedLayoutType ?? ''))
      return
    const next = { ...parentOverrides, [selectedLayoutNode]: parent || null }
    parentOverrides = next
    void persistOperatorLayout(
      pinnedPositions,
      portSides,
      portOrders,
      portOffsets,
      edgeRoutes,
      next,
    )
    graph = applyLayoutOverrides(graph, pinnedPositions, portSides, portOrders, portOffsets, next)
    serverLayout = undefined
  }

  function selectedBlockSpacing(side: keyof BlockSpacing): number {
    if (!selectedLayoutNode) return 0
    const node = graph?.nodes.find((candidate) => candidate.id === selectedLayoutNode)
    const group = graph?.subgraphs?.find((candidate) => candidate.id === selectedLayoutNode)
    return (
      blockSpacingOverrides[selectedLayoutNode]?.[side] ??
      node?.style?.outerSpacing?.[side] ??
      group?.style?.outerSpacing?.[side] ??
      20
    )
  }

  function setSelectedBlockSpacing(side: keyof BlockSpacing, raw: string) {
    if (!graph || !selectedLayoutNode) return
    const value = Math.min(1000, Math.max(0, Number(raw) || 0))
    const next = {
      ...blockSpacingOverrides,
      [selectedLayoutNode]: { ...blockSpacingOverrides[selectedLayoutNode], [side]: value },
    }
    blockSpacingOverrides = next
    void persistOperatorLayout(pinnedPositions, portSides, portOrders, portOffsets, edgeRoutes)
    graph = applyLayoutOverrides(graph, pinnedPositions, portSides, portOrders, portOffsets)
    serverLayout = undefined
  }

  const objectIconTypes = [
    ['generic', 'Generic'],
    ['server', 'Server / VM'],
    ['router', 'Router'],
    ['l2-switch', 'L2 switch'],
    ['l3-switch', 'L3 switch'],
    ['firewall', 'Firewall'],
    ['vpn', 'VPN'],
    ['cloud', 'Cloud'],
    ['internet', 'Internet'],
    ['database', 'Database'],
    ['load-balancer', 'Load balancer'],
  ]

  function topologyTenant() {
    const tenant = graph?.nodes
      .map((node) => node.metadata?.tenant)
      .find((value) => typeof value === 'string' && value.trim())
    return typeof tenant === 'string' ? tenant : ''
  }

  function filteredIconTypes() {
    const query = iconQuery.trim().toLowerCase()
    return query
      ? objectIconTypes.filter(
          ([value, label]) => value.includes(query) || label.toLowerCase().includes(query),
        )
      : objectIconTypes
  }

  async function readLocalIcon(file: File): Promise<string> {
    if (file.size > 450_000) throw new Error('Icon exceeds 450 KB')
    const type = file.type.toLowerCase()
    if (type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
      const document = new DOMParser().parseFromString(await file.text(), 'image/svg+xml')
      const root = document.documentElement
      if (root.localName !== 'svg' || document.querySelector('parsererror'))
        throw new Error('Invalid SVG')
      const allowedElements = new Set([
        'svg',
        'g',
        'path',
        'rect',
        'circle',
        'ellipse',
        'polygon',
        'polyline',
        'line',
        'defs',
        'linearGradient',
        'radialGradient',
        'stop',
        'clipPath',
      ])
      const allowedAttributes = new Set([
        'xmlns',
        'viewBox',
        'width',
        'height',
        'fill',
        'stroke',
        'stroke-width',
        'stroke-linecap',
        'stroke-linejoin',
        'fill-rule',
        'clip-rule',
        'd',
        'points',
        'x',
        'y',
        'cx',
        'cy',
        'r',
        'rx',
        'ry',
        'x1',
        'x2',
        'y1',
        'y2',
        'transform',
        'opacity',
        'stop-color',
        'stop-opacity',
        'id',
        'offset',
        'clip-path',
      ])
      for (const element of [...root.querySelectorAll('*')]) {
        if (!allowedElements.has(element.localName)) {
          element.remove()
          continue
        }
        for (const attribute of [...element.attributes]) {
          if (
            !allowedAttributes.has(attribute.name) ||
            /url\(|javascript:|data:/i.test(attribute.value)
          )
            element.removeAttribute(attribute.name)
        }
      }
      for (const attribute of [...root.attributes]) {
        if (
          !allowedAttributes.has(attribute.name) ||
          /url\(|javascript:|data:/i.test(attribute.value)
        )
          root.removeAttribute(attribute.name)
      }
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`
    }
    if (
      ![
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/x-icon',
        'image/vnd.microsoft.icon',
      ].includes(type)
    ) {
      throw new Error('Use SVG, PNG, JPEG, WebP or ICO')
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(new Error('Unable to read icon file'))
      reader.readAsDataURL(file)
    })
  }

  async function uploadObjectIcon(file: File | undefined) {
    if (!file || !objectDraft) return
    iconImportError = ''
    try {
      const icon = await readLocalIcon(file)
      if (icon.length > 750_000) throw new Error('Encoded icon exceeds 750 KB')
      objectDraft.icon = icon
    } catch (error) {
      iconImportError = error instanceof Error ? error.message : 'Unable to import icon'
    }
  }

  async function importObjectIconUrl() {
    if (!objectDraft) return
    iconImportError = ''
    try {
      const url = new URL(iconImportUrl)
      if (url.protocol !== 'https:') throw new Error('Use an HTTPS image URL')
      const response = await fetch(url, { credentials: 'omit', mode: 'cors' })
      if (!response.ok) throw new Error(`Icon download failed (${response.status})`)
      const blob = await response.blob()
      const file = new File([blob], url.pathname.split('/').pop() || 'icon', { type: blob.type })
      const icon = await readLocalIcon(file)
      if (icon.length > 750_000) throw new Error('Encoded icon exceeds 750 KB')
      objectDraft.icon = icon
    } catch (error) {
      iconImportError =
        error instanceof Error
          ? error.message
          : 'Import failed; download the image and upload it from your computer'
    }
  }

  function startAddObject() {
    objectDraft = {
      id: `operator-${Date.now()}`,
      label: ['New block'],
      parent: undefined,
      type: 'generic',
      tenant: topologyTenant(),
      notes: '',
      origin: 'Manual',
    }
    objectSource = 'Manual'
    iconQuery = ''
    objectEditorOpen = true
    void prepareBindingEditor()
  }

  async function prepareBindingEditor() {
    bindingResults = []
    bindingError = ''
    try {
      const sources = (await api.dataSources.list()).filter((source) => source.type === 'netbox')
      bindingSources = sources.map((source) => ({ id: source.id, name: source.name }))
      bindingSourceId = objectDraft?.binding?.dataSourceId ?? bindingSources[0]?.id ?? ''
      bindingKind = objectDraft?.binding?.kind ?? 'virtual-machine'
      bindingQuery = objectDraft?.binding?.objectName ?? ''
    } catch (error) {
      bindingError = error instanceof Error ? error.message : 'Unable to load NetBox sources'
    }
  }

  async function searchBindingObjects() {
    if (!bindingSourceId) return
    bindingLoading = true
    bindingError = ''
    try {
      bindingResults = await api.dataSources.listBindableObjects(
        bindingSourceId,
        bindingKind,
        bindingQuery,
      )
      if (bindingResults.length === 0) bindingError = 'No matching NetBox objects'
    } catch (error) {
      bindingError = error instanceof Error ? error.message : 'NetBox search failed'
    } finally {
      bindingLoading = false
    }
  }

  function bindObject(result: { id: string; kind: string; name: string; label: string[] }) {
    if (!objectDraft) return
    objectDraft.binding = {
      dataSourceId: bindingSourceId,
      kind: result.kind,
      objectId: result.id,
      objectName: result.name,
    }
    objectDraft.origin = 'NetBox'
    objectDraft.reference = undefined
    objectDraft.label = [...result.label]
    if (result.kind === 'virtual-machine') objectDraft.type = 'server'
    else if (result.kind === 'device') objectDraft.type = 'router'
    else if (result.kind === 'prefix' || result.kind === 'ip-address') objectDraft.type = 'cloud'
    bindingQuery = result.name
    bindingResults = []
  }

  function unlinkObjectBinding() {
    if (!objectDraft) return
    objectDraft.binding = undefined
    objectDraft.origin = objectDraft.reference ? 'Existing object' : 'Manual'
    bindingResults = []
  }

  function chooseExistingObject(nodeId: string) {
    if (!objectDraft || !graph) return
    const source = graph.nodes.find((node) => node.id === nodeId)
    if (!source) return
    const label = Array.isArray(source.label) ? source.label.map(String) : [String(source.label)]
    objectDraft.reference = { nodeId: source.id, nodeName: label[0] ?? source.id }
    objectDraft.binding = undefined
    objectDraft.origin = 'Existing object'
    objectDraft.label = [...label]
    objectDraft.type =
      source.spec?.kind === 'service' ? 'generic' : String(source.spec?.type ?? 'generic')
    objectDraft.icon = source.spec?.icon
    const sourceTenant = source.metadata?.tenant
    if (typeof sourceTenant === 'string' && sourceTenant.trim()) objectDraft.tenant = sourceTenant
  }

  function changeObjectSource(source: 'Manual' | 'NetBox' | 'Existing object') {
    if (!objectDraft) return
    objectSource = source
    objectDraft.origin = source
    if (source !== 'NetBox') objectDraft.binding = undefined
    if (source !== 'Existing object') objectDraft.reference = undefined
  }

  async function refreshBoundNodes(nodes: OperatorNode[]): Promise<OperatorNode[]> {
    return Promise.all(
      nodes.map(async (node) => {
        if (!node.binding) return node
        try {
          const matches = await api.dataSources.listBindableObjects(
            node.binding.dataSourceId,
            node.binding.kind,
            '',
            node.binding.objectId,
          )
          const current = matches.find((item) => item.id === node.binding?.objectId)
          return current
            ? {
                ...node,
                label: current.label,
                binding: { ...node.binding, objectName: current.name },
              }
            : node
        } catch {
          return node
        }
      }),
    )
  }

  function startEditSelectedObject() {
    if (!graph || !selectedLayoutNode || selectedLayoutType !== 'node') return
    const node = graph.nodes.find((candidate) => candidate.id === selectedLayoutNode)
    if (!node) return
    const manual = operatorNodes.find((candidate) => candidate.id === node.id)
    objectDraft = manual
      ? { ...manual, label: [...manual.label] }
      : {
          id: node.id,
          label: Array.isArray(node.label) ? node.label.map(String) : [String(node.label)],
          parent: effectiveParent(node.id) || undefined,
          type: node.spec?.kind === 'service' ? 'generic' : String(node.spec?.type ?? 'generic'),
          icon: node.spec?.icon,
          tenant:
            typeof node.metadata?.tenant === 'string' ? node.metadata.tenant : topologyTenant(),
          origin: 'Manual',
        }
    objectSource =
      objectDraft.origin ??
      (objectDraft.binding ? 'NetBox' : objectDraft.reference ? 'Existing object' : 'Manual')
    iconQuery = ''
    objectEditorOpen = true
    void prepareBindingEditor()
  }

  function saveObjectDraft() {
    if (!graph || !objectDraft) return
    const cleaned = objectDraft.label.map((line) => line.trim()).filter(Boolean)
    if (cleaned.length === 0) return
    const normalized = { ...objectDraft, label: cleaned }
    const isGenerated = graph.nodes.some(
      (node) => node.id === normalized.id && !operatorNodes.some((manual) => manual.id === node.id),
    )
    let nextNodes = operatorNodes
    let nextOverrides = presentationOverrides
    let nextParents = parentOverrides
    if (isGenerated) {
      nextOverrides = {
        ...presentationOverrides,
        [normalized.id]: { label: normalized.label, type: normalized.type, icon: normalized.icon },
      }
      nextParents = { ...parentOverrides, [normalized.id]: normalized.parent ?? null }
    } else {
      const index = operatorNodes.findIndex((node) => node.id === normalized.id)
      nextNodes =
        index >= 0
          ? operatorNodes.map((node, i) => (i === index ? normalized : node))
          : [...operatorNodes, normalized]
    }
    operatorNodes = nextNodes
    presentationOverrides = nextOverrides
    parentOverrides = nextParents
    void persistOperatorLayout(
      pinnedPositions,
      portSides,
      portOrders,
      portOffsets,
      edgeRoutes,
      nextParents,
      nextNodes,
      nextOverrides,
    )
    graph = applyLayoutOverrides(
      graph,
      pinnedPositions,
      portSides,
      portOrders,
      portOffsets,
      nextParents,
      nextNodes,
      nextOverrides,
    )
    serverLayout = undefined
    objectEditorOpen = false
    objectDraft = null
  }

  function resetSelectedPresentation() {
    if (!selectedLayoutNode) return
    const next = { ...presentationOverrides }
    delete next[selectedLayoutNode]
    const nextParents = { ...parentOverrides }
    delete nextParents[selectedLayoutNode]
    presentationOverrides = next
    parentOverrides = nextParents
    void persistOperatorLayout(
      pinnedPositions,
      portSides,
      portOrders,
      portOffsets,
      edgeRoutes,
      nextParents,
      operatorNodes,
      next,
    )
    objectEditorOpen = false
    objectDraft = null
    void loadGraph()
  }

  function resetPresentationField(field: 'label' | 'type' | 'icon' | 'parent') {
    if (!objectDraft) return
    const nodeId = objectDraft.id
    const nextOverrides = { ...presentationOverrides }
    const nextParents = { ...parentOverrides }
    if (field === 'parent') {
      delete nextParents[nodeId]
    } else {
      const current = { ...(nextOverrides[nodeId] ?? {}) }
      delete current[field]
      if (Object.keys(current).length === 0) delete nextOverrides[nodeId]
      else nextOverrides[nodeId] = current
    }
    presentationOverrides = nextOverrides
    parentOverrides = nextParents
    void persistOperatorLayout(
      pinnedPositions,
      portSides,
      portOrders,
      portOffsets,
      edgeRoutes,
      nextParents,
      operatorNodes,
      nextOverrides,
    )
    objectEditorOpen = false
    objectDraft = null
    void loadGraph()
  }

  function deleteObjectDraft() {
    if (!graph || !objectDraft || !operatorNodes.some((node) => node.id === objectDraft?.id)) return
    const removedId = objectDraft.id
    const nextNodes = operatorNodes.filter((node) => node.id !== removedId)
    const nextLinks = operatorLinks.filter(
      (link) => link.from !== removedId && link.to !== removedId,
    )
    const nextPins = { ...pinnedPositions }
    delete nextPins[removedId]
    operatorNodes = nextNodes
    operatorLinks = nextLinks
    pinnedPositions = nextPins
    void persistOperatorLayout(
      nextPins,
      portSides,
      portOrders,
      portOffsets,
      edgeRoutes,
      parentOverrides,
      nextNodes,
      presentationOverrides,
      nextLinks,
    )
    objectEditorOpen = false
    objectDraft = null
    void loadGraph()
  }

  function startAddLink() {
    const first = selectedLayoutType === 'node' ? (selectedLayoutNode ?? '') : ''
    linkDraft = {
      id: `operator-link-${Date.now()}`,
      from: first,
      to: '',
      label: 'connection',
      relationship: 'network',
      direction: 'forward',
      tenant: topologyTenant(),
      notes: '',
      fromSide: 'right',
      toSide: 'left',
    }
    linkDraftError = ''
    linkEditorOpen = true
  }

  function startEditSelectedLink() {
    if (!selectedLayoutLinkId) return
    const existing = operatorLinks.find((link) => link.id === selectedLayoutLinkId)
    if (!existing) return
    linkDraft = { ...existing }
    linkDraftError = ''
    linkEditorOpen = true
  }

  function startEditSelectedAppearance() {
    const link = graph?.links.find((candidate) => candidate.id === selectedLayoutLinkId)
    if (!link?.id) return
    const saved = linkAppearanceOverrides[link.id]
    const rawContinuation = linkContinuationOverrides[link.id] ?? link.metadata?.['continuation']
    const continuation =
      rawContinuation && typeof rawContinuation === 'object' && !Array.isArray(rawContinuation)
        ? (rawContinuation as Partial<LinkContinuation>)
        : undefined
    const dash = link.style?.strokeDasharray ?? ''
    const preset =
      link.type === 'double'
        ? 'double'
        : dash === '8 5'
          ? 'dashed'
          : dash === '1 5'
            ? 'dotted'
            : dash === '10 4 2 4'
              ? 'dash-dot'
              : dash === '16 6'
                ? 'long-dash'
                : 'solid'
    appearanceDraft = {
      id: link.id,
      color: saved?.color ?? link.style?.stroke ?? '#475569',
      width: saved?.width ?? link.style?.strokeWidth ?? 3,
      preset: saved?.preset ?? preset,
      routeShape:
        saved?.routeShape ?? (link.metadata?.['routeShape'] === 'straight' ? 'straight' : 'bent'),
      routePolicy:
        saved?.routePolicy ?? (link.metadata?.['routePolicy'] === 'under' ? 'under' : 'avoid'),
      from: linkPortOverrides[link.id]?.from ?? link.from.port,
      to: linkPortOverrides[link.id]?.to ?? link.to.port,
      continuationEnabled: continuation?.enabled === true,
      continuationLabel:
        continuation?.label ??
        (Array.isArray(link.label) ? link.label.join(' / ') : (link.label ?? '')),
      continuationLength: continuation?.length ?? 48,
    }
    appearanceDraftError = ''
    appearanceEditorOpen = true
  }

  function saveSelectedAppearance(clearManualRoute = false) {
    if (!appearanceDraft || !graph) return
    if (appearanceDraft.continuationEnabled && !appearanceDraft.continuationLabel.trim()) {
      appearanceDraftError = 'Enter a label for both ends of the connection.'
      return
    }
    const source = baseGraph ?? graph
    const link =
      source.links.find((candidate) => candidate.id === appearanceDraft?.id) ??
      graph.links.find((candidate) => candidate.id === appearanceDraft?.id)
    if (!link?.id) return
    const fromNode = graph.nodes.find((node) => node.id === link.from.node)
    const toNode = graph.nodes.find((node) => node.id === link.to.node)
    if (
      !fromNode?.ports?.some((port) => port.id === appearanceDraft?.from) ||
      !toNode?.ports?.some((port) => port.id === appearanceDraft?.to)
    )
      return
    const nextAppearance = {
      ...linkAppearanceOverrides,
      [link.id]: {
        color: appearanceDraft.color,
        width: Math.min(12, Math.max(1, Number(appearanceDraft.width) || 3)),
        preset: appearanceDraft.preset,
        routeShape: appearanceDraft.routeShape,
        routePolicy: appearanceDraft.routePolicy,
      },
    }
    const nextPorts = { ...linkPortOverrides }
    const nextContinuations = { ...linkContinuationOverrides }
    const generatedContinuation = link.metadata?.['continuation']
    const previousContinuation =
      nextContinuations[link.id] ??
      (generatedContinuation && typeof generatedContinuation === 'object'
        ? (generatedContinuation as Partial<LinkContinuation>)
        : undefined)
    if (
      appearanceDraft.continuationEnabled ||
      (generatedContinuation && typeof generatedContinuation === 'object') ||
      Object.hasOwn(nextContinuations, link.id)
    ) {
      nextContinuations[link.id] = {
        enabled: appearanceDraft.continuationEnabled,
        label: appearanceDraft.continuationLabel.trim(),
        length: Math.min(160, Math.max(28, Number(appearanceDraft.continuationLength) || 48)),
        ...(previousContinuation?.source ? { source: previousContinuation.source } : {}),
        ...(previousContinuation?.destination
          ? { destination: previousContinuation.destination }
          : {}),
      }
    }
    const selectedPorts = {
      ...(appearanceDraft.from !== link.from.port ? { from: appearanceDraft.from } : {}),
      ...(appearanceDraft.to !== link.to.port ? { to: appearanceDraft.to } : {}),
    }
    if (Object.keys(selectedPorts).length) nextPorts[link.id] = selectedPorts
    else delete nextPorts[link.id]
    const nextRoutes = { ...edgeRoutes }
    const prior = linkAppearanceOverrides[link.id]
    const priorShape =
      prior?.routeShape ?? (link.metadata?.['routeShape'] === 'straight' ? 'straight' : 'bent')
    const priorPolicy =
      prior?.routePolicy ?? (link.metadata?.['routePolicy'] === 'under' ? 'under' : 'avoid')
    if (
      clearManualRoute ||
      appearanceDraft.routeShape !== priorShape ||
      appearanceDraft.routePolicy !== priorPolicy
    ) {
      delete nextRoutes[link.id]
    }
    edgeRoutes = nextRoutes
    linkAppearanceOverrides = nextAppearance
    linkPortOverrides = nextPorts
    linkContinuationOverrides = nextContinuations
    void persistOperatorLayout(pinnedPositions, portSides, portOrders, portOffsets, nextRoutes)
    graph = applyLayoutOverrides(source, pinnedPositions, portSides, portOrders, portOffsets)
    serverLayout = undefined
    appearanceEditorOpen = false
    appearanceDraft = null
  }

  function selectRouteShape(shape: LinkAppearance['routeShape']) {
    if (appearanceDraft) appearanceDraft.routeShape = shape
  }

  function setContinuationEnabled(enabled: boolean) {
    if (appearanceDraft) appearanceDraft.continuationEnabled = enabled
  }

  function moveContinuationMarker(id: string, index: number, x: number, y: number) {
    if (!layoutEdit || !graph || !Number.isFinite(x) || !Number.isFinite(y)) return
    const source = baseGraph ?? graph
    const link = source.links.find((candidate) => candidate.id === id)
    if (!link) return
    const raw = linkContinuationOverrides[id] ?? link.metadata?.['continuation']
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const continuation = raw as Partial<LinkContinuation>
    if (continuation.enabled !== true || !continuation.label?.trim()) return
    const next = {
      ...linkContinuationOverrides,
      [id]: {
        ...continuation,
        enabled: true,
        label: continuation.label,
        [index === 0 ? 'source' : 'destination']: { x, y },
      },
    }
    linkContinuationOverrides = next
    void persistOperatorLayout(pinnedPositions, portSides, portOrders, portOffsets, edgeRoutes)
    graph = applyLayoutOverrides(source, pinnedPositions, portSides, portOrders, portOffsets)
    serverLayout = undefined
  }

  function resetContinuationMarkers() {
    if (!appearanceDraft || !graph) return
    const id = appearanceDraft.id
    const current = linkContinuationOverrides[id]
    if (!current) return
    const { source: _source, destination: _destination, ...rest } = current
    linkContinuationOverrides = { ...linkContinuationOverrides, [id]: rest }
    void persistOperatorLayout(pinnedPositions, portSides, portOrders, portOffsets, edgeRoutes)
    graph = applyLayoutOverrides(
      baseGraph ?? graph,
      pinnedPositions,
      portSides,
      portOrders,
      portOffsets,
    )
    serverLayout = undefined
  }

  function selectRoutePolicy(policy: LinkAppearance['routePolicy']) {
    if (!appearanceDraft) return
    appearanceDraft.routeShape = 'bent'
    appearanceDraft.routePolicy = policy
  }

  function selectedLinkAppearance():
    | Pick<LinkAppearance, 'routeShape' | 'routePolicy'>
    | undefined {
    if (!selectedLayoutLinkId) return undefined
    const saved = linkAppearanceOverrides[selectedLayoutLinkId]
    if (saved) return saved
    const link = graph?.links.find((candidate) => candidate.id === selectedLayoutLinkId)
    if (!link) return undefined
    return {
      routeShape: link.metadata?.['routeShape'] === 'straight' ? 'straight' : 'bent',
      routePolicy: link.metadata?.['routePolicy'] === 'under' ? 'under' : 'avoid',
    }
  }

  function setSelectedLinkRouting(
    shape: LinkAppearance['routeShape'],
    policy: LinkAppearance['routePolicy'],
  ) {
    if (!selectedLayoutLinkId) return
    startEditSelectedAppearance()
    if (!appearanceDraft) return
    appearanceDraft.routeShape = shape
    appearanceDraft.routePolicy = policy
    saveSelectedAppearance(true)
  }

  function selectStrokePreset(preset: LinkAppearance['preset']) {
    if (appearanceDraft) appearanceDraft.preset = preset
  }

  function appearancePorts(side: 'from' | 'to') {
    const link = graph?.links.find((candidate) => candidate.id === appearanceDraft?.id)
    return graph?.nodes.find((node) => node.id === link?.[side].node)?.ports ?? []
  }

  function appearanceEndpointName(side: 'from' | 'to'): string {
    return nodeLabelById(graph?.nodes, editorLink?.[side].node ?? '')
  }

  function readablePortName(
    port: NonNullable<NetworkGraph['nodes'][number]['ports']>[number],
    index: number,
  ): string {
    const label = (port.label ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
    const side = port.placement?.side
    return label || `Point ${index + 1}${side ? ` · ${side}` : ''}`
  }

  function autoPlaceLinkSides() {
    if (!graph || !linkDraft) return
    const from = graph.nodes.find((node) => node.id === linkDraft?.from)?.position
    const to = graph.nodes.find((node) => node.id === linkDraft?.to)?.position
    if (!from || !to) {
      linkDraft.fromSide = 'right'
      linkDraft.toSide = 'left'
      return
    }
    const dx = to.x - from.x
    const dy = to.y - from.y
    if (Math.abs(dx) >= Math.abs(dy)) {
      linkDraft.fromSide = dx >= 0 ? 'right' : 'left'
      linkDraft.toSide = dx >= 0 ? 'left' : 'right'
    } else {
      linkDraft.fromSide = dy >= 0 ? 'bottom' : 'top'
      linkDraft.toSide = dy >= 0 ? 'top' : 'bottom'
    }
  }

  function saveLinkDraft() {
    if (!graph || !linkDraft?.from || !linkDraft.to || linkDraft.from === linkDraft.to) return
    const normalized = { ...linkDraft, label: linkDraft.label.trim() || 'connection' }
    const duplicate = operatorLinks.some(
      (link) =>
        link.id !== normalized.id &&
        ((link.from === normalized.from && link.to === normalized.to) ||
          (link.from === normalized.to && link.to === normalized.from)),
    )
    if (duplicate) {
      linkDraftError = 'A manual connection between these blocks already exists.'
      return
    }
    const index = operatorLinks.findIndex((link) => link.id === normalized.id)
    const next =
      index >= 0
        ? operatorLinks.map((link, i) => (i === index ? normalized : link))
        : [...operatorLinks, normalized]
    operatorLinks = next
    void persistOperatorLayout(
      pinnedPositions,
      portSides,
      portOrders,
      portOffsets,
      edgeRoutes,
      parentOverrides,
      operatorNodes,
      presentationOverrides,
      next,
    )
    graph = applyLayoutOverrides(
      graph,
      pinnedPositions,
      portSides,
      portOrders,
      portOffsets,
      parentOverrides,
      operatorNodes,
      presentationOverrides,
      next,
    )
    serverLayout = undefined
    linkEditorOpen = false
    linkDraft = null
    linkDraftError = ''
  }

  function deleteLinkDraft() {
    if (!linkDraft || !operatorLinks.some((link) => link.id === linkDraft?.id)) return
    const next = operatorLinks.filter((link) => link.id !== linkDraft?.id)
    operatorLinks = next
    void persistOperatorLayout(
      pinnedPositions,
      portSides,
      portOrders,
      portOffsets,
      edgeRoutes,
      parentOverrides,
      operatorNodes,
      presentationOverrides,
      next,
    )
    linkEditorOpen = false
    linkDraft = null
    selectedLayoutLinkId = null
    void loadGraph()
  }

  function startAddGroup() {
    groupDraft = {
      id: `operator-group-${Date.now()}`,
      label: 'New group',
      parent: undefined,
      direction: 'LR',
      tenant: topologyTenant(),
      notes: '',
    }
    groupEditorOpen = true
  }

  function startEditSelectedGroup() {
    if (!selectedLayoutNode || selectedLayoutType !== 'subgraph') return
    const existing = operatorGroups.find((group) => group.id === selectedLayoutNode)
    if (!existing) return
    groupDraft = { ...existing }
    groupEditorOpen = true
  }

  function startEditGroup(group: OperatorGroup) {
    selectedLayoutNode = group.id
    selectedLayoutType = 'subgraph'
    groupDraft = { ...group }
    groupEditorOpen = true
    groupManagerOpen = false
  }

  function saveGroupDraft() {
    if (!graph || !groupDraft?.label.trim()) return
    const normalized = { ...groupDraft, label: groupDraft.label.trim() }
    const index = operatorGroups.findIndex((group) => group.id === normalized.id)
    const next =
      index >= 0
        ? operatorGroups.map((group, i) => (i === index ? normalized : group))
        : [...operatorGroups, normalized]
    operatorGroups = next
    void persistOperatorLayout(
      pinnedPositions,
      portSides,
      portOrders,
      portOffsets,
      edgeRoutes,
      parentOverrides,
      operatorNodes,
      presentationOverrides,
      operatorLinks,
      next,
    )
    graph = applyLayoutOverrides(
      graph,
      pinnedPositions,
      portSides,
      portOrders,
      portOffsets,
      parentOverrides,
      operatorNodes,
      presentationOverrides,
      operatorLinks,
      next,
    )
    serverLayout = undefined
    groupEditorOpen = false
    groupDraft = null
  }

  function deleteOperatorGroup(removedId: string) {
    if (!operatorGroups.some((group) => group.id === removedId)) return
    const nextGroups = operatorGroups
      .filter((group) => group.id !== removedId)
      .map((group) => (group.parent === removedId ? { ...group, parent: undefined } : group))
    const nextNodes = operatorNodes.map((node) =>
      node.parent === removedId ? { ...node, parent: undefined } : node,
    )
    const nextParents = { ...parentOverrides }
    for (const [id, parent] of Object.entries(nextParents))
      if (parent === removedId) nextParents[id] = null
    delete nextParents[removedId]
    operatorGroups = nextGroups
    operatorNodes = nextNodes
    parentOverrides = nextParents
    void persistOperatorLayout(
      pinnedPositions,
      portSides,
      portOrders,
      portOffsets,
      edgeRoutes,
      nextParents,
      nextNodes,
      presentationOverrides,
      operatorLinks,
      nextGroups,
    )
    groupEditorOpen = false
    groupDraft = null
    groupManagerOpen = false
    if (selectedLayoutNode === removedId) {
      selectedLayoutNode = null
      selectedLayoutType = null
    }
    void loadGraph()
  }

  function deleteGroupDraft() {
    if (groupDraft) deleteOperatorGroup(groupDraft.id)
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

    const parents = new Map(
      (graph.subgraphs ?? []).map((candidate) => [candidate.id, candidate.parent]),
    )
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
    if (hovered.kind === 'port') {
      for (const node of g.nodes) {
        const port = node.ports?.find((candidate) => `${node.id}:${candidate.id}` === hovered.id)
        if (!port) continue
        const description = portPresentationOverrides[hovered.id]?.description ?? port.notes
        const name = port.label || 'Connection point'
        return `<strong>${escapeHtml(name)}</strong>${description ? `<br>${escapeHtml(description)}` : ''}`
      }
      return '<strong>Connection point</strong>'
    }
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
    if (e.key === 'Escape' && portEditorOpen) {
      portEditorOpen = false
      portDraft = null
      viewer?.clearSelection()
      handleSelect(null, null)
      e.preventDefault()
      return
    }
    if (
      e.key === 'Escape' &&
      layoutEdit &&
      !objectEditorOpen &&
      !linkEditorOpen &&
      !groupEditorOpen &&
      !appearanceEditorOpen
    ) {
      if (selectedLayoutNode || selectedLayoutLinkId || selectedLayoutPinIds.length > 0) {
        viewer?.clearSelection()
        handleSelect(null, null)
        e.preventDefault()
      }
      return
    }
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

    {#if layoutSaveError}
      <div class="warnings-banner" role="alert">
        <span class="warning-text">Layout not saved: {layoutSaveError}</span>
      </div>
    {/if}

    <TopologyViewer
      bind:this={viewer}
      graph={visibleGraph}
      sheetId={currentSheetId}
      cameraResetKey={topologyId}
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
      oncontinuationmove={moveContinuationMarker}
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
        <SemanticLayerOverlay
          {svgElement}
          graph={activeGraph}
          hiddenLayers={hiddenSemanticLayerSet}
          forcedLinkIds={new Set([...highlightedPathLinks, ...controlPlanePath.linkIds])}
        />
        <NodeStatusOverlay
          {svgElement}
          status={nodeStatusView}
          enabled={$liveUpdatesEnabled && $showNodeStatus}
        />
        <HighlightOverlay
          {svgElement}
          highlightedIds={editorSourceVisualId
    ? new Set([editorSourceVisualId])
    : highlightedPathNodes}
          highlightedLinkIds={appearanceEditorOpen && appearanceDraft
    ? new Set([appearanceDraft.id])
    : highlightedPathLinks}
          secondaryHighlightedIds={editorDestinationVisualId
    ? new Set([editorDestinationVisualId])
    : controlPlanePath.nodeIds}
          secondaryHighlightedLinkIds={controlPlanePath.linkIds}
          dimOthers={pathExplorerOpen && highlightedPathNodes.size > 0 && !editorSourceId}
          highlightColor={editorSourceId ? '#2563eb' : (selectedTrafficFlow?.primaryColor ?? '#2563eb')}
          secondaryHighlightColor={editorDestinationId
    ? '#f97316'
    : (selectedTrafficFlow?.controlColor ?? '#8b5cf6')}
          pulseAnimation={false}
        />
        <TooltipOverlay {svgElement} graph={activeGraph} contentBuilder={buildTooltip} />
      {/snippet}
    </TopologyViewer>
  {/if}

  <!-- Zoom / utility controls -->
  {#if layoutEdit && selectedLayoutNode && ['node', 'subgraph'].includes(selectedLayoutType ?? '')}
    <div class="parent-editor">
      <strong>Container</strong>
      <span
        >{graph?.nodes.find((node) => node.id === selectedLayoutNode)?.label ??
    graph?.subgraphs?.find((subgraph) => subgraph.id === selectedLayoutNode)?.label ??
    selectedLayoutNode}</span
      >
      <select
        aria-label="Parent container"
        value={effectiveParent(selectedLayoutNode)}
        onchange={(event) => changeSelectedParent(event.currentTarget.value)}
      >
        <option value="">Top level</option>
        {#each availableParentsFor(selectedLayoutNode) as parent}
          <option value={parent.id}>{parent.label ?? parent.id}</option>
        {/each}
      </select>
      <strong>Space around block</strong>
      <div class="spacing-pickers">
        {#each ['top', 'right', 'bottom', 'left'] as side}
          <label
            >{side}
            <input
              type="number"
              min="0"
              max="1000"
              step="10"
              value={selectedBlockSpacing(side as keyof BlockSpacing)}
              onchange={(event) => setSelectedBlockSpacing(side as keyof BlockSpacing, event.currentTarget.value)}
            >
          </label>
        {/each}
      </div>
    </div>
  {/if}
  {#if layoutEdit && objectEditorOpen && objectDraft}
    <div class="object-editor">
      <div class="object-editor-title">
        <strong
          >{operatorNodes.some((node) => node.id === objectDraft?.id)
    ? 'Edit operator block'
    : graph?.nodes.some((node) => node.id === objectDraft?.id)
      ? 'Edit block appearance'
      : 'Add block'}</strong
        >
        <button
          onclick={() => {
    objectEditorOpen = false
    objectDraft = null
  }}
          aria-label="Close object editor"
        >
          ×
        </button>
      </div>
      <label
        >Object source
        <select
          value={objectSource}
          onchange={(event) => changeObjectSource(event.currentTarget.value as typeof objectSource)}
        >
          <option value="Manual">Manual documentation</option>
          <option value="NetBox">NetBox inventory</option>
          <option value="Existing object">Existing topology object</option>
        </select>
      </label>
      {#if objectSource === 'Existing object'}
        <label
          >Referenced object
          <select
            value={objectDraft.reference?.nodeId ?? ''}
            onchange={(event) => chooseExistingObject(event.currentTarget.value)}
          >
            <option value="">Choose an existing block</option>
            {#each graph?.nodes.filter((node) => node.id !== objectDraft?.id && !node.metadata?.operatorObject) ?? [] as node}
              <option value={node.id}>{nodeLabel(node)}</option>
            {/each}
          </select>
        </label>
      {/if}
      <label
        >Text inside block
        {#if presentationOverrides[objectDraft.id]?.label}
          <span class="override-marker">overridden</span>
        {/if}
        <textarea
          rows="5"
          value={objectDraft.label.join('\n')}
          oninput={(event) => {
    if (objectDraft) objectDraft.label = event.currentTarget.value.split('\n')
  }}
        ></textarea>
        {#if presentationOverrides[objectDraft.id]?.label}
          <button class="field-reset" onclick={() => resetPresentationField('label')}>
            Reset text to source
          </button>
        {/if}
      </label>
      <label
        >Icon
        {#if presentationOverrides[objectDraft.id]?.type}
          <span class="override-marker">overridden</span>
        {/if}
        <input bind:value={iconQuery} placeholder="Search icons">
        <select bind:value={objectDraft.type}>
          {#if !filteredIconTypes().some(([value]) => value === objectDraft?.type)}
            <option value={objectDraft.type}>{objectDraft.type}</option>
          {/if}
          {#each filteredIconTypes() as icon}
            <option value={icon[0]}>{icon[1]}</option>
          {/each}
        </select>
        {#if presentationOverrides[objectDraft.id]?.type}
          <button class="field-reset" onclick={() => resetPresentationField('type')}>
            Reset icon to source
          </button>
        {/if}
      </label>
      <div class="service-icon-editor">
        <strong>Service icon</strong>
        {#if objectDraft.icon}
          <img src={objectDraft.icon} alt="Selected service icon">
          <button
            onclick={() => {
    if (objectDraft) objectDraft.icon = undefined
  }}
          >
            Remove custom icon
          </button>
        {/if}
        <div class="service-icon-list">
          {#each serviceIcons as item}
            <button
              class:chosen={objectDraft.icon === item.icon}
              onclick={() => {
    if (objectDraft) objectDraft.icon = item.icon
  }}
              title={item.label}
              aria-label={`Use ${item.label} icon`}
            >
              <img src={item.icon} alt=""><span>{item.label}</span>
            </button>
          {/each}
        </div>
        <label
          >Upload from computer (SVG, PNG, JPEG, WebP, ICO)
          <input
            type="file"
            accept=".svg,.png,.jpg,.jpeg,.webp,.ico,image/svg+xml,image/png,image/jpeg,image/webp,image/x-icon"
            onchange={(event) => void uploadObjectIcon(event.currentTarget.files?.[0])}
          >
        </label>
        <label
          >Import HTTPS image to local storage
          <input type="url" bind:value={iconImportUrl} placeholder="https://example.com/icon.svg">
        </label>
        <button onclick={() => void importObjectIconUrl()}>Import icon</button>
        {#if iconImportError}
          <span class="editor-error">{iconImportError}</span>
        {/if}
        {#if presentationOverrides[objectDraft.id]?.icon}
          <button class="field-reset" onclick={() => resetPresentationField('icon')}>
            Reset service icon to source
          </button>
        {/if}
      </div>
      <label
        >Tenant
        <input bind:value={objectDraft.tenant} placeholder="MSP, admiral, ing…">
      </label>
      <label
        >Operator notes
        <textarea
          rows="3"
          bind:value={objectDraft.notes}
          placeholder="Purpose, owner or operational note"
        ></textarea>
      </label>
      <label
        >Container
        {#if Object.hasOwn(parentOverrides, objectDraft.id)}
          <span class="override-marker">overridden</span>
        {/if}
        <select
          value={objectDraft.parent ?? ''}
          onchange={(event) => {
    if (objectDraft) objectDraft.parent = event.currentTarget.value || undefined
  }}
        >
          <option value="">Top level</option>
          {#each availableParentsFor(objectDraft.id) as parent}
            <option value={parent.id}>{parent.label ?? parent.id}</option>
          {/each}
        </select>
        {#if Object.hasOwn(parentOverrides, objectDraft.id)}
          <button class="field-reset" onclick={() => resetPresentationField('parent')}>
            Reset container to source
          </button>
        {/if}
      </label>
      {#if objectSource === 'NetBox'}
        <fieldset class="binding-editor">
          <legend>NetBox data binding</legend>
          {#if objectDraft.binding}
            <div class="binding-current">
              <strong>{objectDraft.binding.objectName}</strong>
              <span>{objectDraft.binding.kind} · ID {objectDraft.binding.objectId}</span>
              <button onclick={unlinkObjectBinding}>Unlink</button>
            </div>
          {/if}
          {#if bindingSources.length > 0}
            <div class="binding-grid">
              <label
                >Source
                <select bind:value={bindingSourceId}>
                  {#each bindingSources as source}
                    <option value={source.id}>{source.name}</option>
                  {/each}
                </select>
              </label>
              <label
                >Object type
                <select bind:value={bindingKind}>
                  <option value="virtual-machine">Virtual machine</option>
                  <option value="device">Device</option>
                  <option value="ip-address">IP address</option>
                  <option value="prefix">Prefix / network</option>
                </select>
              </label>
            </div>
            <div class="binding-search">
              <input
                bind:value={bindingQuery}
                placeholder="Name, IP or object ID"
                onkeydown={(event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void searchBindingObjects()
    }
  }}
              >
              <button onclick={searchBindingObjects} disabled={bindingLoading}>
                {bindingLoading ? 'Searching…' : 'Search'}
              </button>
            </div>
            {#if bindingResults.length > 0}
              <div class="binding-results">
                {#each bindingResults as result}
                  <button onclick={() => bindObject(result)}>
                    <strong>{result.name}</strong><span>{result.label.slice(1).join(' · ')}</span>
                  </button>
                {/each}
              </div>
            {/if}
          {:else if !bindingError}
            <div class="empty-editor-state">No NetBox data source is configured.</div>
          {/if}
          {#if bindingError}
            <div class="editor-error">{bindingError}</div>
          {/if}
        </fieldset>
      {/if}
      <div class="object-editor-actions">
        {#if operatorNodes.some((node) => node.id === objectDraft?.id)}
          <button class="danger" onclick={deleteObjectDraft}>Delete block</button>
        {/if}
        {#if presentationOverrides[objectDraft.id] || Object.hasOwn(parentOverrides, objectDraft.id)}
          <button onclick={resetSelectedPresentation}>Reset all presentation</button>
        {/if}
        <button class="primary" onclick={saveObjectDraft}>Save block</button>
      </div>
    </div>
  {/if}
  {#if layoutEdit && linkEditorOpen && linkDraft}
    <div class="object-editor link-editor">
      <div class="object-editor-title">
        <strong
          >{operatorLinks.some((link) => link.id === linkDraft?.id) ? 'Edit connection' : 'Add connection'}</strong
        >
        <button
          onclick={() => {
    linkEditorOpen = false
    linkDraft = null
  }}
          aria-label="Close connection editor"
        >
          ×
        </button>
      </div>
      <label
        >Source
        <span class="editor-help"
          >{linkDraft.from
    ? `${nodeLabelById(graph?.nodes, linkDraft.from)} · blue block`
    : 'Choose the block where the connection starts'}</span
        >
        <select bind:value={linkDraft.from}>
          <option value="">Choose a block</option>
          {#each graph?.nodes ?? [] as node}
            <option value={node.id}>{nodeLabel(node)}</option>
          {/each}
        </select>
      </label>
      <label
        >Destination
        <span class="editor-help"
          >{linkDraft.to
    ? `${nodeLabelById(graph?.nodes, linkDraft.to)} · orange block`
    : 'Choose the block where the connection ends'}</span
        >
        <select bind:value={linkDraft.to}>
          <option value="">Choose a block</option>
          {#each graph?.nodes ?? [] as node}
            <option value={node.id}>{nodeLabel(node)}</option>
          {/each}
        </select>
      </label>
      <label
        >Connection label
        <input bind:value={linkDraft.label}>
      </label>
      <div class="side-pickers">
        <label>Tenant <input bind:value={linkDraft.tenant} placeholder="MSP, admiral, ing…"></label>
        <label
          >Operator notes
          <input bind:value={linkDraft.notes} placeholder="Purpose or operational note"></label
        >
      </div>
      <div class="side-pickers">
        <label
          >Relationship
          <select bind:value={linkDraft.relationship}>
            <option value="network">Network</option>
            <option value="management">Management</option>
            <option value="dependency">Dependency</option>
            <option value="traffic">Traffic flow</option>
            <option value="documentation">Documentation</option>
          </select>
        </label>
        <label
          >Direction
          <select bind:value={linkDraft.direction}>
            <option value="forward">Source → destination</option>
            <option value="back">Source ← destination</option>
            <option value="both">Bidirectional</option>
            <option value="none">Undirected</option>
          </select>
        </label>
      </div>
      <div class="side-pickers">
        <label
          >Source side
          <select bind:value={linkDraft.fromSide}>
            <option value="right">Right</option>
            <option value="left">Left</option>
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
          </select>
        </label>
        <label
          >Destination side
          <select bind:value={linkDraft.toSide}>
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
          </select>
        </label>
      </div>
      <button onclick={autoPlaceLinkSides}>Choose sides from current placement</button>
      {#if linkDraftError}
        <div class="editor-error">{linkDraftError}</div>
      {/if}
      <div class="object-editor-actions">
        {#if operatorLinks.some((link) => link.id === linkDraft?.id)}
          <button class="danger" onclick={deleteLinkDraft}>Delete connection</button>
        {/if}
        <button
          class="primary"
          disabled={!linkDraft.from || !linkDraft.to || linkDraft.from === linkDraft.to}
          onclick={saveLinkDraft}
        >
          Create connection
        </button>
      </div>
    </div>
  {/if}
  {#if layoutEdit && portEditorOpen && portDraft}
    <div class="object-editor port-editor">
      <div class="object-editor-title">
        <strong>Connection point</strong>
        <button
          aria-label="Close connection point editor"
          title="Close"
          onclick={() => { portEditorOpen = false; portDraft = null }}
        >
          ×
        </button>
      </div>
      <label>Label <input bind:value={portDraft.label} placeholder="LAN, WAN, API…"></label>
      <label
        >Description
        <textarea
          bind:value={portDraft.description}
          rows="2"
          placeholder="Purpose of this connection point"
        ></textarea></label
      >
      <div class="object-editor-actions">
        <button class="primary" onclick={savePortDraft}>Save point</button>
      </div>
    </div>
  {/if}
  {#if layoutEdit && appearanceEditorOpen && appearanceDraft}
    <div class="object-editor link-editor">
      <div class="object-editor-title">
        <strong>Connection appearance and anchors</strong>
        <button
          onclick={() => {
    appearanceEditorOpen = false
    appearanceDraft = null
  }}
          aria-label="Close connection appearance"
        >
          ×
        </button>
      </div>
      <div class="side-pickers">
        <label>Color <input type="color" bind:value={appearanceDraft.color}></label>
        <label
          >Width
          <input
            type="number"
            min="1"
            max="12"
            step="0.5"
            bind:value={appearanceDraft.width}
          ></label
        >
      </div>
      <div class="line-type-field">
        <span>Path</span>
        <div class="line-type-picker" role="group" aria-label="Connection path">
          <button
            type="button"
            class:active={appearanceDraft.routeShape === 'straight'}
            aria-label="Straight line"
            aria-pressed={appearanceDraft.routeShape === 'straight'}
            title="Straight line"
            onclick={() => selectRouteShape('straight')}
          >
            <svg viewBox="0 0 48 24" aria-hidden="true"><path d="M4 12 L44 12" /></svg>
          </button>
          <button
            type="button"
            class:active={appearanceDraft.routeShape === 'bent'}
            aria-label="Line with bends"
            aria-pressed={appearanceDraft.routeShape === 'bent'}
            title="Line with bends"
            onclick={() => selectRouteShape('bent')}
          >
            <svg viewBox="0 0 48 24" aria-hidden="true">
              <path d="M4 19 C18 19 15 5 27 5 S36 16 44 5" />
            </svg>
          </button>
        </div>
      </div>
      <div class="line-type-field">
        <span>Connection</span>
        <div class="line-type-picker" role="group" aria-label="Connection continuity">
          <button
            type="button"
            class:active={!appearanceDraft.continuationEnabled}
            aria-label="Continuous connection"
            aria-pressed={!appearanceDraft.continuationEnabled}
            title="Draw the full connection"
            onclick={() => setContinuationEnabled(false)}
          >
            <svg viewBox="0 0 48 24" aria-hidden="true"><path d="M4 12 H44" /></svg>
          </button>
          <button
            type="button"
            class:active={appearanceDraft.continuationEnabled}
            aria-label="Paired continuation"
            aria-pressed={appearanceDraft.continuationEnabled}
            title="Show two ends of one connection"
            onclick={() => setContinuationEnabled(true)}
          >
            <svg viewBox="0 0 48 24" aria-hidden="true">
              <path d="M4 12 H17 M31 12 H44" />
              <path d="M19 7 V17 M29 7 V17" />
            </svg>
          </button>
        </div>
      </div>
      {#if appearanceDraft.continuationEnabled}
        <div class="side-pickers">
          <label
            >Both ends label
            <input maxlength="100" bind:value={appearanceDraft.continuationLabel}></label
          >
          <label
            >Stub length
            <input
              type="number"
              min="28"
              max="160"
              step="1"
              bind:value={appearanceDraft.continuationLength}
            ></label
          >
        </div>
        <p class="editor-help">Both ends belong to the same connection and highlight together.</p>
        {#if linkContinuationOverrides[appearanceDraft.id]?.source || linkContinuationOverrides[appearanceDraft.id]?.destination}
          <button type="button" onclick={resetContinuationMarkers}>Reset marker positions</button>
        {/if}
      {/if}
      <div class="line-type-field">
        <span>Stroke</span>
        <div class="line-type-picker" role="group" aria-label="Connection stroke">
          {#each strokePresets as preset}
            <button
              type="button"
              class:active={appearanceDraft.preset === preset.id}
              aria-label={preset.label}
              aria-pressed={appearanceDraft.preset === preset.id}
              title={preset.label}
              onclick={() => selectStrokePreset(preset.id)}
            >
              <svg viewBox="0 0 48 24" aria-hidden="true">
                {#if preset.id === 'double'}
                  <path d="M4 9 L44 9 M4 15 L44 15" />
                {:else}
                  <path d="M4 12 L44 12" stroke-dasharray={preset.dash || undefined} />
                {/if}
              </svg>
            </button>
          {/each}
        </div>
      </div>
      <div class="line-type-field">
        <span>At blocks</span>
        {#if appearanceDraft.continuationEnabled}
          <p class="editor-help">
            A paired continuation only draws short ends. Switch to a continuous connection to route
            its line around or through blocks.
          </p>
        {:else}
          <div class="line-type-picker" role="group" aria-label="Connection at blocks">
            <button
              type="button"
              class:active={appearanceDraft.routeShape === 'bent' && appearanceDraft.routePolicy === 'avoid'}
              aria-label="Go around blocks"
              aria-pressed={appearanceDraft.routeShape === 'bent' && appearanceDraft.routePolicy === 'avoid'}
              title="Go around blocks"
              onclick={() => selectRoutePolicy('avoid')}
            >
              <svg viewBox="0 0 48 24" aria-hidden="true">
                <rect x="20" y="7" width="8" height="10" rx="1" />
                <path d="M3 12 H10 Q14 12 14 7 V4 H34 V7 Q34 12 38 12 H45" />
              </svg>
            </button>
            <button
              type="button"
              class:active={appearanceDraft.routePolicy === 'under' || appearanceDraft.routeShape === 'straight'}
              aria-label="Pass through blocks"
              aria-pressed={appearanceDraft.routePolicy === 'under' || appearanceDraft.routeShape === 'straight'}
              title="Pass through blocks"
              onclick={() => selectRoutePolicy('under')}
            >
              <svg viewBox="0 0 48 24" aria-hidden="true">
                <rect x="20" y="7" width="8" height="10" rx="1" />
                <path d="M3 12 H45" />
              </svg>
            </button>
          </div>
        {/if}
      </div>
      <label
        >Source point
        <span class="editor-help">{appearanceEndpointName('from')} · blue block</span>
        <select bind:value={appearanceDraft.from}>
          {#each appearancePorts('from') as port, index}
            <option value={port.id}>{readablePortName(port, index)}</option>
          {/each}
        </select>
      </label>
      <label
        >Destination point
        <span class="editor-help">{appearanceEndpointName('to')} · orange block</span>
        <select bind:value={appearanceDraft.to}>
          {#each appearancePorts('to') as port, index}
            <option value={port.id}>{readablePortName(port, index)}</option>
          {/each}
        </select>
      </label>
      <p class="editor-help">
        Several connections may select the same point. Each line keeps its own color, width and
        style.
      </p>
      <div class="object-editor-actions">
        {#if appearanceDraftError}
          <span role="alert">{appearanceDraftError}</span>
        {/if}
        <button class="primary" onclick={() => saveSelectedAppearance()}>Save connection</button>
      </div>
    </div>
  {/if}
  {#if layoutEdit && groupEditorOpen && groupDraft}
    <div class="object-editor group-editor">
      <div class="object-editor-title">
        <strong
          >{operatorGroups.some((group) => group.id === groupDraft?.id) ? 'Edit group' : 'Add group'}</strong
        >
        <button
          onclick={() => {
    groupEditorOpen = false
    groupDraft = null
  }}
          aria-label="Close group editor"
        >
          ×
        </button>
      </div>
      <label>Group name <input bind:value={groupDraft.label}></label>
      <label>Tenant <input bind:value={groupDraft.tenant} placeholder="MSP, admiral, ing…"></label>
      <label
        >Operator notes
        <textarea
          rows="3"
          bind:value={groupDraft.notes}
          placeholder="Purpose, owner or operational note"
        ></textarea></label
      >
      <label
        >Parent container
        <select
          value={groupDraft.parent ?? ''}
          onchange={(event) => {
    if (groupDraft) groupDraft.parent = event.currentTarget.value || undefined
  }}
        >
          <option value="">Top level</option>
          {#each availableParentsFor(groupDraft.id) as parent}
            <option value={parent.id}>{parent.label ?? parent.id}</option>
          {/each}
        </select>
      </label>
      <label
        >Internal layout
        <select bind:value={groupDraft.direction}>
          <option value="LR">Left to right</option>
          <option value="RL">Right to left</option>
          <option value="TB">Top to bottom</option>
          <option value="BT">Bottom to top</option>
        </select>
      </label>
      <div class="object-editor-actions">
        {#if operatorGroups.some((group) => group.id === groupDraft?.id)}
          <button class="danger" onclick={deleteGroupDraft}>Delete group</button>
        {/if}
        <button class="primary" onclick={saveGroupDraft}>Save group</button>
      </div>
    </div>
  {/if}
  {#if layoutEdit && groupManagerOpen}
    <div class="object-editor group-manager">
      <div class="object-editor-title">
        <strong>Container groups</strong>
        <button
          onclick={() => {
    groupManagerOpen = false
  }}
          aria-label="Close group manager"
        >
          ×
        </button>
      </div>
      {#if operatorGroups.length === 0}
        <div class="empty-editor-state">No operator groups</div>
      {:else}
        <div class="group-list">
          {#each operatorGroups as group}
            <div class="group-list-row">
              <button class="group-name" onclick={() => startEditGroup(group)}>
                {group.label}
              </button>
              <button
                class="danger"
                onclick={() => deleteOperatorGroup(group.id)}
                aria-label={`Delete ${group.label}`}
              >
                Delete
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
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
        {#if layoutEdit}
          <button
            onclick={startAddObject}
            title="Add standalone block"
            aria-label="Add standalone block"
          >
            <PlusIcon size={18} />
          </button>
          <button onclick={startAddLink} title="Connect two blocks" aria-label="Connect two blocks">
            ⛓
          </button>
          <button
            onclick={startAddGroup}
            title="Add container group"
            aria-label="Add container group"
          >
            ▣
          </button>
          <button
            onclick={() => {
    groupManagerOpen = !groupManagerOpen
  }}
            class:active={groupManagerOpen}
            title="Manage container groups"
            aria-label="Manage container groups"
          >
            ▤
          </button>
        {/if}
        {#if layoutEdit && selectedLayoutType === 'node' && selectedLayoutNode}
          <button
            onclick={startEditSelectedObject}
            title="Edit selected block"
            aria-label="Edit selected block"
          >
            <PencilSimpleIcon size={18} />
          </button>
        {/if}
        {#if layoutEdit &&
    selectedLayoutType === 'edge' &&
    selectedLayoutLinkId &&
    operatorLinks.some((link) => link.id === selectedLayoutLinkId)}
          <button
            onclick={startEditSelectedLink}
            title="Edit selected connection"
            aria-label="Edit selected connection"
          >
            <PencilSimpleIcon size={18} />
          </button>
        {/if}
        {#if layoutEdit && selectedLayoutType === 'edge' && selectedLayoutLinkId}
          <button
            onclick={startEditSelectedAppearance}
            title="Connection appearance, routing and shared points"
            aria-label="Connection appearance and shared points"
          >
            ◒
          </button>
        {/if}
        {#if layoutEdit &&
    selectedLayoutType === 'subgraph' &&
    selectedLayoutNode &&
    operatorGroups.some((group) => group.id === selectedLayoutNode)}
          <button
            onclick={startEditSelectedGroup}
            title="Edit selected group"
            aria-label="Edit selected group"
          >
            <PencilSimpleIcon size={18} />
          </button>
        {/if}
        {#if layoutEdit && selectedLayoutNode && selectedLayoutPinIds.length > 0}
          <button onclick={unpinSelected} title="Unpin selected node or block">×</button>
        {/if}
        {#if layoutEdit && selectedLayoutLinkId}
          <button
            onclick={() => setSelectedLinkRouting('bent', 'avoid')}
            class:active={(selectedLinkAppearance()?.routeShape ?? 'bent') === 'bent' && (selectedLinkAppearance()?.routePolicy ?? 'avoid') === 'avoid' && !Object.hasOwn(edgeRoutes, selectedLayoutLinkId)}
            title="Route selected connection around blocks"
            aria-label="Route selected connection around blocks"
          >
            <svg class="route-control-icon" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="8" width="6" height="8" rx="1" />
              <path d="M2 12h3c2 0 2-7 7-7s5 7 7 7h3" />
            </svg>
          </button>
          <button
            onclick={() => setSelectedLinkRouting('bent', 'under')}
            class:active={selectedLinkAppearance()?.routePolicy === 'under' && selectedLinkAppearance()?.routeShape !== 'straight'}
            title="Let selected connection pass through blocks"
            aria-label="Let selected connection pass through blocks"
          >
            <svg class="route-control-icon" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="8" width="6" height="8" rx="1" />
              <path d="M2 12h20" />
            </svg>
          </button>
          <button
            onclick={() => setSelectedLinkRouting('straight', 'under')}
            class:active={selectedLinkAppearance()?.routeShape === 'straight'}
            title="Draw selected connection as a straight line"
            aria-label="Draw selected connection as a straight line"
          >
            <svg class="route-control-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2 18 22 6" />
            </svg>
          </button>
          {#if (edgeRoutes[selectedLayoutLinkId]?.length ?? 0) > 0}
            <span class="route-mode" title="Drag bends to adjust the manual route">Manual</span>
          {/if}
        {/if}
        {#if layoutEdit &&
    (Object.keys(pinnedPositions).length > 0 ||
      Object.keys(portSides).length > 0 ||
      Object.keys(edgeRoutes).length > 0 ||
      Object.keys(parentOverrides).length > 0)}
          <button
            onclick={resetOperatorLayout}
            title="Reset all saved layout"
            aria-label="Reset all saved layout"
          >
            <ArrowCounterClockwiseIcon size={18} />
          </button>
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
        onclick={() => {
    layersOpen = !layersOpen
    dataHealthOpen = false
  }}
        title="Information layers"
        aria-label="Information layers"
        class:active={layersOpen}
      >
        <StackIcon size={18} />
      </button>
      <button
        onclick={() => {
    pathExplorerOpen = !pathExplorerOpen
    dataHealthOpen = false
  }}
        title="Trace traffic path"
        aria-label="Trace traffic path"
        class:active={pathExplorerOpen}
      >
        <PathIcon size={18} />
      </button>
      <button
        onclick={() => {
    dataHealthOpen = !dataHealthOpen
    layersOpen = false
    pathExplorerOpen = false
  }}
        title="Data freshness and reconciliation"
        aria-label="Data freshness and reconciliation"
        class:active={dataHealthOpen}
      >
        <DatabaseIcon size={18} />
      </button>
    </div>
  </div>

  {#if layersOpen}
    <div class="layers-panel">
      <div class="layers-title">Information layers</div>
      {#if availableSemanticLayers.length > 0}
        <div class="layers-title">Diagram relationships</div>
        {#each availableSemanticLayers as semanticLayer}
          <label>
            <input
              type="checkbox"
              checked={!hiddenSemanticLayerSet.has(semanticLayer)}
              onchange={(event) => setSemanticLayer(semanticLayer, event.currentTarget.checked)}
            >
            {semanticLayer}
          </label>
        {/each}
      {/if}
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
          checked={operatorObjectsVisible}
          onchange={(e) => setLayer('operatorObjects', e.currentTarget.checked)}
        >
        Operator objects</label
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

  {#if dataHealthOpen}
    <div class="data-health-panel">
      <div class="layers-title">Data health</div>
      <div class="data-health-summary">
        <span
          class:healthy={reconciliationIssues.length === 0}
          class:warning={reconciliationIssues.length > 0}
        >
          {reconciliationIssues.length === 0
    ? 'Sources agree'
    : reconciliationIssues.length === 1
      ? '1 discrepancy'
      : `${reconciliationIssues.length} discrepancies`}
        </span>
      </div>
      {#each dataFreshness as item}
        <div class="freshness-row">
          <strong>{item.source}</strong>
          <span>{new Date(item.observedAt).toLocaleString()}</span>
        </div>
      {/each}
      {#if reconciliationIssues.length > 0}
        <div class="issue-list">
          {#each reconciliationIssues as issue}
            <button
              class="issue-card"
              class:mismatch={issue.status === 'mismatch'}
              class:unverified={issue.status === 'unknown' || issue.status === 'unverified'}
              onclick={() => inspectReconciliationIssue(issue.nodeId)}
              title={`Inspect ${issue.node}`}
            >
              <strong>{issue.node}</strong>
              <span>{issue.field} · {issue.status.toUpperCase()}</span>
              <span>NetBox: {issue.netbox}</span>
              <span>Observed: {issue.observed}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if pathExplorerOpen}
    <div class="path-panel">
      <div class="layers-title">Traffic path</div>
      <label
        >Source
        <select bind:value={pathSourceId}>
          <option value="">Select source</option>
          {#each pathNodes as item}
            <option value={item.id}>{item.label}</option>
          {/each}
        </select>
      </label>
      <label
        >Destination
        <select bind:value={pathDestinationId}>
          <option value="">Select destination</option>
          {#each pathNodes as item}
            <option value={item.id}>{item.label}</option>
          {/each}
        </select>
      </label>
      <label
        >Traffic flow
        <select
          value={pathFlowId}
          onchange={(event) => selectTrafficFlow(event.currentTarget.value)}
        >
          <option value="">Select operational flow</option>
          {#each availableTrafficFlows as flow}
            <option value={flow.id}>{flow.label}</option>
          {/each}
        </select>
      </label>
      {#if !readOnly}
        <button class="flow-editor-toggle" onclick={() => (flowEditorOpen = !flowEditorOpen)}>
          {flowEditorOpen ? 'Close flow editor' : 'Edit flows'}
        </button>
      {/if}
      {#if flowEditorOpen && !readOnly}
        <div class="flow-editor">
          <div class="flow-editor-actions">
            <strong>Saved flows</strong>
            <button onclick={newFlowDraft}>New</button>
          </div>
          {#each editableTrafficFlows as flow}
            <div class="flow-editor-row">
              <button class="flow-name" onclick={() => editFlowDraft(flow)}>{flow.label}</button>
              {#if customTrafficFlows.some((item) => item.id === flow.id)}
                <button title="Move up" onclick={() => moveCustomFlow(flow.id, -1)}>↑</button>
                <button title="Move down" onclick={() => moveCustomFlow(flow.id, 1)}>↓</button>
                <button
                  title={flow.enabled === false ? 'Enable' : 'Disable'}
                  onclick={() => toggleCustomFlow(flow)}
                >
                  {flow.enabled === false ? '○' : '●'}
                </button>
                <button title="Duplicate" onclick={() => duplicateCustomFlow(flow)}>⧉</button>
                <button title="Delete" onclick={() => deleteCustomFlow(flow.id)}>×</button>
              {:else}
                <button title="Create an editable copy" onclick={() => editFlowDraft(flow)}>
                  Import
                </button>
              {/if}
            </div>
          {/each}
          {#if flowDraft}
            <div class="flow-draft">
              <label>Name <input bind:value={flowDraft.label}></label>
              <label
                >Source
                <select bind:value={flowDraft.source}>
                  <option value="">Select source</option>
                  {#each pathNodes as item}
                    <option value={item.id}>{item.label}</option>
                  {/each}
                </select>
              </label>
              <label
                >Destination
                <select bind:value={flowDraft.destination}>
                  <option value="">Select destination</option>
                  {#each pathNodes as item}
                    <option value={item.id}>{item.label}</option>
                  {/each}
                </select>
              </label>
              <div class="flow-colors">
                <label>Data <input type="color" bind:value={flowDraft.primaryColor}></label>
                <label>Control <input type="color" bind:value={flowDraft.controlColor}></label>
              </div>
              <fieldset>
                <legend>Primary data-path links</legend>
                <small
                  >Select links in traffic order. Leave empty to use the calculated shortest
                  path.</small
                >
                {#each graph.links as link}
                  <label class="flow-link-option">
                    <input
                      type="checkbox"
                      checked={flowDraft.primaryLinkIds?.includes(link.id)}
                      onchange={(event) => {
    const current = flowDraft?.primaryLinkIds ?? []
    if (!flowDraft) return
    flowDraft.primaryLinkIds = event.currentTarget.checked
      ? [...current, link.id]
      : current.filter((id) => id !== link.id)
    if (event.currentTarget.checked)
      flowDraft.controlLinkIds = (flowDraft.controlLinkIds ?? []).filter((id) => id !== link.id)
  }}
                    >
                    {flowLinkLabel(link)}
                  </label>
                {/each}
              </fieldset>
              <fieldset>
                <legend>Supporting control-plane links</legend>
                <small>Highlighted alongside the data path using the control color.</small>
                {#each graph.links as link}
                  <label class="flow-link-option">
                    <input
                      type="checkbox"
                      checked={flowDraft.controlLinkIds?.includes(link.id)}
                      onchange={(event) => {
    const current = flowDraft?.controlLinkIds ?? []
    if (!flowDraft) return
    flowDraft.controlLinkIds = event.currentTarget.checked
      ? [...current, link.id]
      : current.filter((id) => id !== link.id)
    if (event.currentTarget.checked)
      flowDraft.primaryLinkIds = (flowDraft.primaryLinkIds ?? []).filter((id) => id !== link.id)
  }}
                    >
                    {flowLinkLabel(link)}
                  </label>
                {/each}
              </fieldset>
              <div class="flow-editor-actions">
                <button onclick={() => (flowDraft = null)}>Cancel</button>
                <button class="primary" onclick={commitFlowDraft}>Save and preview</button>
              </div>
            </div>
          {/if}
        </div>
      {/if}
      {#if pathSourceId && pathDestinationId}
        {#if trafficPath}
          <div class="path-result">
            {#each trafficPath.hops as hop, index}
              <div class="path-hop">
                <span class="decision {hop.decision.toLowerCase()}">{hop.decision}</span>
                <span>{hop.label}</span>
                {#if index < trafficPath.hops.length - 1}
                  <span class="path-arrow">→</span>
                {/if}
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

  .parent-editor {
    position: absolute;
    right: 64px;
    bottom: 64px;
    z-index: 7;
    display: grid;
    gap: 6px;
    width: min(320px, calc(100% - 96px));
    padding: 10px 12px;
    color: var(--color-text, #111827);
    background: var(--color-bg-elevated, #ffffff);
    border: 1px solid var(--border, #e5e7eb);
    border-radius: 8px;
    box-shadow: 0 4px 14px rgba(15, 23, 42, 0.14);
    font-size: 12px;
  }

  .parent-editor span {
    overflow: hidden;
    color: var(--color-text-muted, #64748b);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .parent-editor select {
    min-width: 0;
    padding: 7px 9px;
    color: var(--color-text, #111827);
    background: var(--color-bg, #ffffff);
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 6px;
  }

  .spacing-pickers {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 5px;
  }
  .spacing-pickers label {
    display: grid;
    gap: 3px;
    text-transform: capitalize;
  }
  .spacing-pickers input {
    width: 100%;
    min-width: 0;
    padding: 5px;
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 5px;
  }

  .object-editor {
    position: absolute;
    right: 64px;
    bottom: 16px;
    z-index: 8;
    display: grid;
    gap: 10px;
    width: min(360px, calc(100% - 96px));
    max-height: calc(100% - 32px);
    overflow-y: auto;
    padding: 14px;
    color: var(--color-text, #111827);
    background: var(--color-bg-elevated, #ffffff);
    border: 1px solid var(--border, #e5e7eb);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
  }

  .object-editor-title,
  .object-editor-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .object-editor-title button {
    border: 0;
    background: transparent;
    color: var(--color-text-muted, #64748b);
    cursor: pointer;
    font-size: 20px;
  }

  .object-editor label {
    display: grid;
    gap: 5px;
    font-size: 12px;
    font-weight: 600;
  }

  .object-editor textarea,
  .object-editor select,
  .object-editor input {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 8px 9px;
    color: var(--color-text, #111827);
    background: var(--color-bg, #ffffff);
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 6px;
    font: inherit;
    font-weight: 400;
  }

  .object-editor textarea {
    resize: vertical;
  }
  .service-icon-editor {
    display: grid;
    gap: 8px;
    font-size: 12px;
  }
  .service-icon-editor > img {
    width: 40px;
    height: 40px;
    object-fit: contain;
  }
  .service-icon-list {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 5px;
  }
  .service-icon-list button {
    display: grid;
    justify-items: center;
    gap: 3px;
    min-width: 0;
    padding: 5px;
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 5px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 10px;
  }
  .service-icon-list button.chosen {
    border-color: var(--primary, #2563eb);
    background: #dbeafe;
  }
  .service-icon-list img {
    width: 24px;
    height: 24px;
    object-fit: contain;
  }
  .override-marker {
    color: #b45309;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .object-editor .field-reset {
    justify-self: start;
    padding: 4px 7px;
    color: #b45309;
    background: transparent;
    border: 1px solid #f59e0b;
    border-radius: 5px;
    cursor: pointer;
    font-size: 10px;
  }
  .object-editor-actions {
    justify-content: flex-end;
  }
  .object-editor-actions button {
    padding: 7px 10px;
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 6px;
    background: var(--color-bg, #ffffff);
    cursor: pointer;
  }
  .object-editor-actions button.primary {
    color: white;
    background: var(--primary, #2563eb);
    border-color: var(--primary, #2563eb);
  }
  .object-editor-actions button.danger {
    color: #b91c1c;
    margin-right: auto;
  }
  .side-pickers {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }
  .line-type-field {
    display: grid;
    gap: 5px;
    font-size: 0.78rem;
  }
  .line-type-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .line-type-picker button {
    width: 48px;
    height: 32px;
    display: grid;
    place-items: center;
    padding: 3px;
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 6px;
    background: var(--color-bg, #fff);
    color: var(--color-text, #334155);
    cursor: pointer;
  }
  .line-type-picker button.active {
    border-color: #2563eb;
    background: #dbeafe;
    color: #1d4ed8;
  }
  .line-type-picker svg {
    width: 40px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.5;
    stroke-linecap: round;
  }
  .route-control-icon {
    width: 19px;
    height: 19px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .editor-error {
    color: #b91c1c;
    font-size: 0.75rem;
  }
  .empty-editor-state {
    color: var(--color-text-muted, #64748b);
    font-size: 0.8rem;
  }
  .group-list {
    display: grid;
    gap: 6px;
    max-height: 280px;
    overflow: auto;
  }
  .group-list-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }
  .group-list-row button {
    padding: 7px 9px;
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 6px;
    background: var(--color-bg, #ffffff);
    cursor: pointer;
  }
  .group-list-row .group-name {
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-list-row .danger {
    color: #b91c1c;
  }
  .binding-editor {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 10px;
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 8px;
  }
  .binding-editor legend {
    padding: 0 5px;
    font-size: 12px;
    font-weight: 700;
  }
  .binding-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .binding-search {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px;
  }
  .binding-search input,
  .binding-search button,
  .binding-current button {
    padding: 7px 9px;
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 6px;
    background: var(--color-bg, #fff);
  }
  .binding-results {
    display: grid;
    gap: 5px;
    max-height: 180px;
    overflow: auto;
  }
  .binding-results button {
    display: grid;
    gap: 2px;
    padding: 7px 9px;
    text-align: left;
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 6px;
    background: var(--color-bg, #fff);
    cursor: pointer;
  }
  .binding-results span,
  .binding-current span {
    color: var(--color-text-muted, #64748b);
    font-size: 11px;
  }
  .binding-current {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2px 8px;
    align-items: center;
  }
  .binding-current span {
    grid-column: 1;
  }
  .binding-current button {
    grid-column: 2;
    grid-row: 1 / span 2;
    cursor: pointer;
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
    max-height: calc(100% - 96px);
    overflow: auto;
  }

  .flow-editor-toggle {
    width: 100%;
    margin-top: 10px;
    padding: 6px 8px;
    color: var(--primary, #2563eb);
    background: color-mix(in srgb, var(--primary, #2563eb) 7%, var(--color-bg, #ffffff));
    border: 1px solid color-mix(in srgb, var(--primary, #2563eb) 35%, transparent);
    border-radius: 5px;
    cursor: pointer;
  }
  .flow-editor {
    display: grid;
    gap: 6px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border, #e5e7eb);
  }
  .flow-editor-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .flow-editor-actions button,
  .flow-editor-row button {
    padding: 4px 6px;
    color: var(--color-text, #0f172a);
    background: var(--color-bg, #ffffff);
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 4px;
    cursor: pointer;
  }
  .flow-editor-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .flow-editor-row .flow-name {
    flex: 1;
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .flow-draft {
    display: grid;
    gap: 6px;
    margin-top: 4px;
    padding: 8px;
    background: var(--color-bg-subtle, #f8fafc);
    border: 1px solid var(--border, #e5e7eb);
    border-radius: 6px;
  }
  .flow-draft input:not([type="checkbox"]):not([type="color"]) {
    min-width: 0;
    padding: 5px 7px;
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 4px;
  }
  .flow-draft fieldset {
    max-height: 130px;
    overflow: auto;
    margin: 0;
    border: 1px solid var(--border, #cbd5e1);
    border-radius: 4px;
  }
  .flow-draft .flow-link-option {
    display: flex;
    grid-template-columns: none;
    margin-top: 3px;
  }
  .flow-colors {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .flow-colors label {
    display: flex;
    grid-template-columns: none;
    justify-content: space-between;
  }
  .flow-editor-actions .primary {
    color: #ffffff;
    background: var(--primary, #2563eb);
    border-color: var(--primary, #2563eb);
  }

  .data-health-panel {
    position: absolute;
    top: 72px;
    right: 64px;
    z-index: 8;
    width: min(420px, calc(100% - 96px));
    max-height: calc(100% - 96px);
    overflow: auto;
    padding: 12px;
    color: var(--color-text, #0f172a);
    background: color-mix(in srgb, var(--color-bg-elevated, #ffffff) 96%, transparent);
    border: 1px solid var(--border, #e5e7eb);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
    font-size: 11px;
  }

  .data-health-summary {
    margin: 8px 0;
  }
  .data-health-summary span {
    font-weight: 700;
  }
  .data-health-summary .healthy {
    color: #15803d;
  }
  .data-health-summary .warning {
    color: #b45309;
  }
  .freshness-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 5px 0;
    border-top: 1px solid var(--border, #e5e7eb);
  }
  .freshness-row span {
    color: var(--color-text-muted, #64748b);
  }
  .issue-list {
    display: grid;
    gap: 8px;
    margin-top: 10px;
  }
  .issue-card {
    display: grid;
    gap: 2px;
    width: 100%;
    padding: 8px;
    color: inherit;
    text-align: left;
    background: color-mix(in srgb, #f59e0b 8%, var(--color-bg, #ffffff));
    border: 0;
    border-left: 3px solid #f59e0b;
    border-radius: 4px;
    cursor: pointer;
  }
  .issue-card:hover {
    background: color-mix(in srgb, #f59e0b 16%, var(--color-bg, #ffffff));
  }
  .issue-card.mismatch {
    border-left-color: #dc2626;
  }
  .issue-card.mismatch:hover {
    background: color-mix(in srgb, #dc2626 12%, var(--color-bg, #ffffff));
  }
  .issue-card.unverified {
    border-left-color: #d97706;
  }
  .issue-card span {
    color: var(--color-text-muted, #64748b);
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

  .decision.allow {
    background: #16a34a;
  }
  .decision.block {
    background: #dc2626;
  }
  .decision.nat {
    background: #ea580c;
  }
  .decision.vpn {
    background: #7c3aed;
  }
  .decision.control {
    background: #8b5cf6;
  }
  .decision.unknown {
    background: #64748b;
  }
  .path-arrow {
    color: var(--color-text-muted, #64748b);
  }
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
