import type { OperatorLayoutState } from './topology.js'

export function emptyOperatorLayout(): OperatorLayoutState {
  return {
    nodePositions: {},
    portSides: {},
    portOrders: {},
    portOffsets: {},
    edgeRoutes: {},
    parentOverrides: {},
    operatorNodes: [],
    presentationOverrides: {},
    operatorLinks: [],
    operatorGroups: [],
    blockSpacingOverrides: {},
    linkAppearanceOverrides: {},
    linkPortOverrides: {},
    linkContinuationOverrides: {},
    portPresentationOverrides: {},
  }
}

export function parseOperatorLayout(value: string | null | undefined): OperatorLayoutState {
  if (!value) return emptyOperatorLayout()
  try {
    const parsed = JSON.parse(value) as Partial<OperatorLayoutState> | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptyOperatorLayout()
    }
    const empty = emptyOperatorLayout()
    return {
      nodePositions: parsed.nodePositions ?? empty.nodePositions,
      portSides: parsed.portSides ?? empty.portSides,
      portOrders: parsed.portOrders ?? empty.portOrders,
      portOffsets: parsed.portOffsets ?? empty.portOffsets,
      edgeRoutes: parsed.edgeRoutes ?? empty.edgeRoutes,
      parentOverrides: parsed.parentOverrides ?? empty.parentOverrides,
      operatorNodes: parsed.operatorNodes ?? empty.operatorNodes,
      presentationOverrides: parsed.presentationOverrides ?? empty.presentationOverrides,
      operatorLinks: parsed.operatorLinks ?? empty.operatorLinks,
      operatorGroups: parsed.operatorGroups ?? empty.operatorGroups,
      blockSpacingOverrides: parsed.blockSpacingOverrides ?? empty.blockSpacingOverrides,
      linkAppearanceOverrides: parsed.linkAppearanceOverrides ?? empty.linkAppearanceOverrides,
      linkPortOverrides: parsed.linkPortOverrides ?? empty.linkPortOverrides,
      linkContinuationOverrides:
        parsed.linkContinuationOverrides ?? empty.linkContinuationOverrides,
      portPresentationOverrides:
        parsed.portPresentationOverrides ?? empty.portPresentationOverrides,
    }
  } catch {
    return emptyOperatorLayout()
  }
}
