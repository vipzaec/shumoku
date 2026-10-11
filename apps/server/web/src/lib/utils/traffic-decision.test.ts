import { describe, expect, it } from 'vitest'
import { trafficDecision } from './traffic-decision'

describe('trafficDecision', () => {
  it('does not infer firewall permission from a route or link label', () => {
    for (const label of ['WAN uplink', 'LAN routing', 'allow', 'deny', 'DNAT TCP :443']) {
      expect(trafficDecision({ label }).status).toBe('UNKNOWN')
    }
  })

  it('requires a concrete rule basis for an explicit allow or block', () => {
    expect(trafficDecision({ metadata: { decision: 'ALLOW' } }).status).toBe('UNKNOWN')
    expect(
      trafficDecision({
        metadata: { decision: 'ALLOW', decisionEvidence: 'OPNsense rule 42, WAN, in' },
      }),
    ).toEqual({ status: 'ALLOW', basis: 'OPNsense rule 42, WAN, in' })
    expect(
      trafficDecision({
        metadata: { decision: 'BLOCK', decisionEvidence: 'OPNsense rule 43, WAN, in' },
      }).status,
    ).toBe('BLOCK')
  })

  it('does not treat NAT or VPN metadata as a firewall verdict', () => {
    expect(trafficDecision({ metadata: { decision: 'NAT' } }).status).toBe('UNKNOWN')
    expect(trafficDecision({ metadata: { decision: 'VPN' } }).status).toBe('UNKNOWN')
  })
})
