export type TrafficDecisionStatus = 'ALLOW' | 'BLOCK' | 'UNKNOWN'

export interface TrafficDecision {
  status: TrafficDecisionStatus
  basis: string
}

/** A route, NAT rule, or suggestive label is not a firewall policy verdict. */
export function trafficDecision(link: Record<string, unknown>): TrafficDecision {
  const metadata =
    link.metadata && typeof link.metadata === 'object' && !Array.isArray(link.metadata)
      ? (link.metadata as Record<string, unknown>)
      : {}
  const explicit = String(metadata.decision ?? '').toUpperCase()
  const evidence =
    typeof metadata.decisionEvidence === 'string' ? metadata.decisionEvidence.trim() : ''

  if ((explicit === 'ALLOW' || explicit === 'BLOCK') && evidence) {
    return { status: explicit, basis: evidence }
  }
  if (explicit === 'UNKNOWN' && evidence) return { status: 'UNKNOWN', basis: evidence }
  if (explicit === 'ALLOW' || explicit === 'BLOCK') {
    return { status: 'UNKNOWN', basis: 'Policy decision has no verified rule evidence' }
  }
  return { status: 'UNKNOWN', basis: 'No evaluated firewall policy rule for this connection' }
}
