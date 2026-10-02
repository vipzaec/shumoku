import { z } from '@hono/zod-openapi'

export const NetworkGraphSchema = z
  .looseObject({
    version: z.string().optional(),
    name: z.string().optional(),
    nodes: z.array(z.record(z.string(), z.unknown())),
    links: z.array(z.record(z.string(), z.unknown())),
    subgraphs: z.array(z.record(z.string(), z.unknown())).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('NetworkGraph')

export const TopologyIdParamsSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' } }),
})

export const ObservationParamsSchema = TopologyIdParamsSchema.extend({
  obsId: z
    .string()
    .min(1)
    .openapi({ param: { name: 'obsId', in: 'path' } }),
})

export const TopologySourceParamsSchema = z.object({
  topologyId: z
    .string()
    .min(1)
    .openapi({ param: { name: 'topologyId', in: 'path' } }),
  sourceId: z
    .string()
    .min(1)
    .openapi({ param: { name: 'sourceId', in: 'path' } }),
})

export const ObservationStatusSchema = z.enum(['ok', 'partial', 'failed', 'empty'])

export const OperatorLayoutSchema = z.object({
  nodePositions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
  portSides: z.record(z.string(), z.enum(['top', 'bottom', 'left', 'right'])),
  portOrders: z.record(z.string(), z.number().int().nonnegative()),
  portOffsets: z.record(z.string(), z.number().min(0).max(1)),
  edgeRoutes: z.record(z.string(), z.array(z.object({ x: z.number(), y: z.number() }))),
  parentOverrides: z.record(z.string(), z.string().nullable()).optional(),
  operatorNodes: z
    .array(
      z.object({
        id: z.string(),
        label: z.array(z.string()),
        parent: z.string().optional(),
        type: z.string(),
        icon: z.string().max(750000).optional(),
        tenant: z.string().optional(),
        notes: z.string().optional(),
        origin: z.enum(['Manual', 'NetBox', 'Existing object']).optional(),
        reference: z.object({ nodeId: z.string(), nodeName: z.string() }).optional(),
        binding: z
          .object({
            dataSourceId: z.string(),
            kind: z.string(),
            objectId: z.string(),
            objectName: z.string(),
          })
          .optional(),
      }),
    )
    .optional(),
  presentationOverrides: z
    .record(
      z.string(),
      z.object({
        label: z.array(z.string()).optional(),
        type: z.string().optional(),
        icon: z.string().max(750000).optional(),
      }),
    )
    .optional(),
  operatorLinks: z
    .array(
      z.object({
        id: z.string(),
        from: z.string(),
        to: z.string(),
        label: z.string(),
        relationship: z
          .enum(['network', 'management', 'dependency', 'traffic', 'documentation'])
          .optional(),
        direction: z.enum(['none', 'forward', 'back', 'both']).optional(),
        tenant: z.string().optional(),
        notes: z.string().optional(),
        fromSide: z.enum(['top', 'bottom', 'left', 'right']),
        toSide: z.enum(['top', 'bottom', 'left', 'right']),
      }),
    )
    .optional(),
  operatorGroups: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        parent: z.string().optional(),
        direction: z.enum(['TB', 'BT', 'LR', 'RL']),
        tenant: z.string().optional(),
        notes: z.string().optional(),
      }),
    )
    .optional(),
  blockSpacingOverrides: z
    .record(
      z.string(),
      z.object({
        top: z.number().min(0).max(1000).optional(),
        right: z.number().min(0).max(1000).optional(),
        bottom: z.number().min(0).max(1000).optional(),
        left: z.number().min(0).max(1000).optional(),
      }),
    )
    .optional(),
  linkAppearanceOverrides: z
    .record(
      z.string(),
      z.object({
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        width: z.number().min(1).max(12),
        preset: z.enum(['solid', 'dashed', 'dotted', 'dash-dot', 'long-dash', 'double']),
        routeShape: z.enum(['straight', 'bent']).optional(),
        routePolicy: z.enum(['avoid', 'under']),
      }),
    )
    .optional(),
  linkPortOverrides: z
    .record(
      z.string(),
      z.object({
        from: z.string().optional(),
        to: z.string().optional(),
      }),
    )
    .optional(),
  portPresentationOverrides: z
    .record(
      z.string(),
      z.object({
        label: z.string().max(100).optional(),
        description: z.string().max(2000).optional(),
      }),
    )
    .optional(),
})

export const ObservationSummarySchema = z.object({
  id: z.string(),
  topologyId: z.string(),
  sourceId: z.string(),
  capturedAt: z.number().int(),
  status: ObservationStatusSchema,
  statusMessage: z.string().optional(),
  nodeCount: z.number().int(),
  linkCount: z.number().int(),
  portCount: z.number().int(),
  createdAt: z.number().int(),
  hasOperatorLayout: z.boolean().optional(),
})

export const ObservationSchema = ObservationSummarySchema.extend({
  graph: NetworkGraphSchema.nullable(),
  contributionChanged: z.boolean().optional(),
  operatorLayout: OperatorLayoutSchema.optional(),
}).openapi('TopologyObservation')

export const ObservationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
})

export const RecordObservationSchema = z.object({
  graph: NetworkGraphSchema,
  status: ObservationStatusSchema.default('ok'),
})

export const LatestSnapshotSchema = z
  .object({
    graph: NetworkGraphSchema.nullable(),
    capturedAt: z.number().int().nullable(),
    status: ObservationStatusSchema.optional(),
    observationId: z.string().optional(),
  })
  .openapi('LatestTopologySnapshot')

export const ResolvedTopologySchema = z
  .object({ graph: NetworkGraphSchema, snapshotCount: z.number().int() })
  .openapi('ResolvedTopology')

export const DisplaySettingsSchema = z
  .object({
    direction: z.enum(['TB', 'BT', 'LR', 'RL']),
    edgeStyle: z.enum(['polyline', 'orthogonal', 'splines', 'straight']),
    splineMode: z.enum(['sloppy', 'conservative', 'conservative_soft']),
    hideDisconnected: z.boolean(),
    operatorLayout: OperatorLayoutSchema,
  })
  .openapi('TopologyDisplaySettings')

export const UpdateDisplaySettingsSchema = DisplaySettingsSchema.partial().openapi(
  'UpdateTopologyDisplaySettings',
)

export const OkResultSchema = z.object({ ok: z.literal(true) }).openapi('OkResult')
