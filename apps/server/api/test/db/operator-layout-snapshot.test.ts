import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createTopologyObservationApplicationService } from '../../src/app/topology-observations.ts'
import { ObservationsService } from '../../src/services/observations.ts'
import { emptyOperatorLayout } from '../../src/services/operator-layout.ts'
import { TopologyService } from '../../src/services/topology.ts'
import { attachSource, getDatabase, insertDataSource, setupTempDb, type TempDb } from './helper.ts'

let temp: TempDb
let observations: ObservationsService
let topologies: TopologyService

beforeAll(() => {
  temp = setupTempDb()
  observations = new ObservationsService()
  topologies = new TopologyService()
})
afterAll(() => temp.teardown())

describe('operator layout snapshots', () => {
  test('every observation stores the layout that existed when it was recorded', async () => {
    const topology = await topologies.create({ name: 'layout snapshot' })
    const sourceId = insertDataSource('manual', 'layout-snapshot-source')
    attachSource(topology.id, sourceId, 'topology')
    const firstLayout = {
      ...emptyOperatorLayout(),
      nodePositions: { firewall: { x: 120, y: 240 } },
      linkContinuationOverrides: { ingress: { enabled: true, label: 'WAN', length: 56 } },
    }
    topologies.writeOperatorLayout(topology.id, firstLayout)

    // Call the low-level writer used by scans, sync jobs and webhooks, not the UI wrapper.
    const first = await observations.record({
      topologyId: topology.id,
      sourceId,
      capturedAt: Date.now(),
      status: 'ok',
      graph: { nodes: [], links: [] },
    })
    expect(first.operatorLayout).toEqual(firstLayout)
    expect(observations.get(first.id)?.operatorLayout).toEqual(firstLayout)

    const secondLayout = {
      ...emptyOperatorLayout(),
      nodePositions: { firewall: { x: 360, y: 240 } },
      linkContinuationOverrides: { ingress: { enabled: false, label: 'WAN' } },
    }
    topologies.writeOperatorLayout(topology.id, secondLayout)
    const second = await observations.record({
      topologyId: topology.id,
      sourceId,
      capturedAt: Date.now() + 1,
      status: 'ok',
      graph: { nodes: [], links: [] },
    })
    expect(observations.get(first.id)?.operatorLayout).toEqual(firstLayout)
    expect(observations.get(second.id)?.operatorLayout).toEqual(secondLayout)

    await createTopologyObservationApplicationService(
      observations,
      topologies,
    ).restoreOperatorLayout(topology.id, first.id)
    expect(topologies.readOperatorLayout(topology.id)).toEqual(firstLayout)

    // Historical revisions without a captured layout must never erase today's edits.
    getDatabase()
      .query('UPDATE topology_observations SET operator_layout_json = NULL WHERE id = ?')
      .run(second.id)
    await expect(
      createTopologyObservationApplicationService(observations, topologies).restoreOperatorLayout(
        topology.id,
        second.id,
      ),
    ).rejects.toThrow('no saved operator layout')
    expect(topologies.readOperatorLayout(topology.id)).toEqual(firstLayout)
  })

  test('a topology without an edited layout still gets an explicit empty snapshot', async () => {
    const topology = await topologies.create({ name: 'empty layout snapshot' })
    const sourceId = insertDataSource('manual', 'empty-layout-source')
    const observation = await observations.record({
      topologyId: topology.id,
      sourceId,
      capturedAt: Date.now(),
      status: 'failed',
      graph: null,
    })
    expect(observation.operatorLayout).toEqual(emptyOperatorLayout())
    expect(observations.get(observation.id)?.operatorLayout).toEqual(emptyOperatorLayout())
  })
})
