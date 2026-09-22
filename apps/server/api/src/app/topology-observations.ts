import type { EdgeStyle, NetworkGraph, SplineMode } from '@shumoku/core'
import type { ObservationsService } from '../services/observations.js'
import type { TopologyService } from '../services/topology.js'
import type { DisplaySettingsView, TopologyObservationApplicationService } from './services.js'

const DEFAULT_DISPLAY_SETTINGS: DisplaySettingsView = {
  direction: 'TB',
  edgeStyle: 'orthogonal',
  splineMode: 'sloppy',
  hideDisconnected: false,
  operatorLayout: {
    nodePositions: {},
    portSides: {},
    portOrders: {},
    portOffsets: {},
    edgeRoutes: {},
  },
}

export function createTopologyObservationApplicationService(
  observations: ObservationsService,
  topologies: TopologyService,
): TopologyObservationApplicationService {
  return {
    list(topologyId, limit) {
      return observations.listForTopology(topologyId, limit).map((observation) => ({
        id: observation.id,
        topologyId: observation.topologyId,
        sourceId: observation.sourceId,
        capturedAt: observation.capturedAt,
        status: observation.status,
        statusMessage: observation.statusMessage,
        nodeCount: observation.nodeCount,
        linkCount: observation.linkCount,
        portCount: observation.portCount,
        createdAt: observation.createdAt,
        hasOperatorLayout: observation.operatorLayout !== undefined,
      }))
    },
    get: (observationId) => observations.get(observationId),
    latest: (topologyId, sourceId) =>
      observations.latestPerSource(topologyId).find((item) => item.sourceId === sourceId) ?? null,
    async record(topologyId, sourceId, graph, status) {
      const observation = await observations.record({
        topologyId,
        sourceId,
        capturedAt: Date.now(),
        status,
        graph,
      })
      const operatorLayout = topologies.readOperatorLayout(topologyId)
      observations.snapshotOperatorLayout(observation.id, operatorLayout)
      observation.operatorLayout = operatorLayout
      if (observation.contributionChanged) {
        topologies.clearCacheEntry(topologyId)
        topologies.precompute(topologyId)
      }
      return observation
    },
    async resolved(topologyId) {
      const parsed = await topologies.getParsed(topologyId)
      if (!parsed) return null
      const snapshotCount = observations
        .latestPerSource(topologyId)
        .filter((item) => item.graph !== null).length
      return { graph: parsed.graph, snapshotCount }
    },
    getDisplaySettings(topologyId) {
      const settings = topologies.readProjectOverlay(topologyId)?.settings
      return {
        direction: settings?.direction ?? DEFAULT_DISPLAY_SETTINGS.direction,
        edgeStyle:
          (settings?.edgeStyle as EdgeStyle | undefined) ?? DEFAULT_DISPLAY_SETTINGS.edgeStyle,
        splineMode:
          (settings?.splineMode as SplineMode | undefined) ?? DEFAULT_DISPLAY_SETTINGS.splineMode,
        hideDisconnected: settings?.hideDisconnected ?? DEFAULT_DISPLAY_SETTINGS.hideDisconnected,
        operatorLayout: topologies.readOperatorLayout(topologyId),
      }
    },
    async updateDisplaySettings(topologyId, patch) {
      if (patch.operatorLayout !== undefined) {
        topologies.writeOperatorLayout(topologyId, patch.operatorLayout)
      }
      const updatesGraphSettings =
        patch.direction !== undefined ||
        patch.edgeStyle !== undefined ||
        patch.splineMode !== undefined ||
        patch.hideDisconnected !== undefined
      if (updatesGraphSettings) {
        const overlay: NetworkGraph = topologies.readProjectOverlay(topologyId) ?? {
          version: '1',
          nodes: [],
          links: [],
        }
        const settings = { ...(overlay.settings ?? {}) }
        if (patch.direction !== undefined) settings.direction = patch.direction
        if (patch.edgeStyle !== undefined) settings.edgeStyle = patch.edgeStyle
        if (patch.edgeStyle === 'splines') settings.splineMode = patch.splineMode ?? 'sloppy'
        else if (patch.edgeStyle !== undefined) delete settings.splineMode
        if (patch.hideDisconnected !== undefined) settings.hideDisconnected = patch.hideDisconnected
        await topologies.writeProjectOverlay(topologyId, { ...overlay, settings })
      }
      return { ok: true }
    },
    async restoreOperatorLayout(topologyId, observationId) {
      const observation = observations.get(observationId)
      if (!observation || observation.topologyId !== topologyId) {
        throw new Error('Observation not found for this topology')
      }
      if (!observation.operatorLayout) throw new Error('This revision has no saved operator layout')
      topologies.writeOperatorLayout(topologyId, observation.operatorLayout)
      topologies.clearCacheEntry(topologyId)
      await topologies.precompute(topologyId)
      return { ok: true }
    },
  }
}
