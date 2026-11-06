/**
 * Global congestion model (#7).
 *
 *   rise = blockedRate × excess(blockedShare) + pendingRate × min(1, pending / pendingReference)
 *   fall = exitRelief × exits + flowDecay × (1 − blockedShare)
 *   congestion += (rise − fall) per second, clamped to [0, limit]
 *
 * - blockedShare: share of active vehicles that have waited at least
 *   `blockedAfterSec` without moving (accumulated waiting time). Being a share,
 *   it does not depend on map or fleet size.
 * - excess(): the part of blockedShare above `blockedTolerance`, rescaled to
 *   0..1, so normal short waits at junctions do not build congestion.
 * - pending: vehicles waiting to enter through a blocked tunnel (incoming
 *   traffic pressure), normalised by `pendingReference`.
 * - exits and free flow relieve congestion.
 * During the first `levelStartGraceSec` of a level, congestion can fall but
 * not rise, so a level transition never causes an immediate loss.
 */
import type { BalanceConfig } from './balance'

export interface CongestionInput {
  readonly active: number
  /** Vehicles that have waited at least `blockedAfterSec`. */
  readonly blocked: number
  readonly pending: number
  /** Vehicles that left the map during this step. */
  readonly exited: number
  /** Seconds since the level started. */
  readonly levelTime: number
}

export interface CongestionTerms {
  readonly blockedShare: number
  readonly rise: number
  readonly fall: number
}

/** The per-second rise and fall terms, for HUD/debugging and tests. */
export function congestionTerms(input: CongestionInput, balance: BalanceConfig, dt: number): CongestionTerms {
  const blockedShare = input.active > 0 ? Math.min(1, input.blocked / input.active) : 0
  const excess = Math.max(0, blockedShare - balance.blockedTolerance) / (1 - balance.blockedTolerance)
  const incoming = Math.min(1, input.pending / balance.pendingReference)
  const inGrace = input.levelTime < balance.levelStartGraceSec
  const rise = inGrace ? 0 : balance.blockedRatePerSec * excess + balance.pendingRatePerSec * incoming
  const fall = (balance.exitRelief * input.exited) / dt + balance.flowDecayPerSec * (1 - blockedShare)
  return { blockedShare, rise, fall }
}

/** Returns the congestion after one step of `dt` seconds. */
export function nextCongestion(current: number, input: CongestionInput, balance: BalanceConfig, dt: number): number {
  const { rise, fall } = congestionTerms(input, balance, dt)
  return Math.min(balance.congestionLimit, Math.max(0, current + (rise - fall) * dt))
}

export type CongestionLevel = 'normal' | 'warning' | 'critical'

export function congestionLevel(value: number, balance: BalanceConfig): CongestionLevel {
  if (value >= balance.criticalThreshold) return 'critical'
  if (value >= balance.warningThreshold) return 'warning'
  return 'normal'
}
