/**
 * Tunable balance values for congestion and level progression (#7).
 * Keep every gameplay coefficient here rather than in simulation code.
 */
import { DEFAULT_CONFIG } from '../config'
import type { VehicleMix } from '../sim/traffic'

export interface BalanceConfig {
  // Level progression
  /** Seconds to survive to complete a level. */
  readonly levelDurationSec: number
  /** Spawn interval at the start of level 1. */
  readonly baseSpawnIntervalSec: number
  /** Spawn interval never drops below this. */
  readonly minSpawnIntervalSec: number
  /** Each level starts with the previous level's start interval × this. */
  readonly levelSpawnFactor: number
  /** Within a level the interval ramps linearly down to start × this. */
  readonly inLevelRampFactor: number
  readonly startingVehicles: number
  /** Extra starting vehicles per level after the first. */
  readonly startingVehiclesPerLevel: number
  readonly maxVehicles: number
  /** Additional active-vehicle capacity per level. */
  readonly maxVehiclesPerLevel: number
  /** Seconds an intersection stays occupied after each crossing vehicle. */
  readonly junctionClearSec: number
  readonly vehicleMix: VehicleMix
  readonly vansPerLevel: number
  readonly trucksPerLevel: number

  // Congestion model (all rates in percentage points)
  /** A vehicle counts as blocked once it has waited this long without moving. */
  readonly blockedAfterSec: number
  /** Fraction of blocked vehicles treated as normal junction waiting. */
  readonly blockedTolerance: number
  /** Rise per second when every vehicle is blocked. */
  readonly blockedRatePerSec: number
  /** Pending (not yet entered) vehicles that count as full incoming pressure. */
  readonly pendingReference: number
  /** Rise per second at full incoming pressure. */
  readonly pendingRatePerSec: number
  /** Drop per vehicle that leaves the map. */
  readonly exitRelief: number
  /** Drop per second while traffic flows freely (scaled by unblocked share). */
  readonly flowDecayPerSec: number
  /** Congestion cannot rise during the first seconds of a level. */
  readonly levelStartGraceSec: number
  /** Run ends when congestion reaches this. */
  readonly congestionLimit: number
  /** HUD thresholds (#8). */
  readonly warningThreshold: number
  readonly criticalThreshold: number
}

export const DEFAULT_BALANCE: BalanceConfig = Object.freeze({
  levelDurationSec: DEFAULT_CONFIG.levelDurationSec,
  // Tuned in simulation over many seeds (no player roads): levels 1–2 stay
  // calm, level 3 builds visible pressure, level 4 is usually lost unless the
  // player relieves bottlenecks. The roadmap's 4 s start never produced any
  // queues on generated maps, so level 1 starts at 2.5 s instead.
  baseSpawnIntervalSec: 2.5,
  minSpawnIntervalSec: DEFAULT_CONFIG.minSpawnIntervalSec,
  levelSpawnFactor: 0.75,
  inLevelRampFactor: 0.6,
  startingVehicles: DEFAULT_CONFIG.startingVehicles,
  startingVehiclesPerLevel: 2,
  maxVehicles: DEFAULT_CONFIG.maxVehicles,
  maxVehiclesPerLevel: 10,
  junctionClearSec: 1.8,
  vehicleMix: Object.freeze({ car: 0.78, van: 0.18, truck: 0.04 }),
  vansPerLevel: 0.025,
  trucksPerLevel: 0.015,

  blockedAfterSec: 2,
  blockedTolerance: 0.1,
  blockedRatePerSec: 8,
  pendingReference: 6,
  pendingRatePerSec: 3,
  exitRelief: 0.75,
  flowDecayPerSec: 1.5,
  levelStartGraceSec: 10,
  congestionLimit: DEFAULT_CONFIG.congestionLimit,
  warningThreshold: 50,
  criticalThreshold: 80,
})

export function createBalance(overrides: Partial<BalanceConfig> = {}): BalanceConfig {
  const b = { ...DEFAULT_BALANCE, ...overrides }
  for (const [key, value] of Object.entries(b)) {
    if (key === 'vehicleMix') continue
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${key} must be a non-negative number`)
  }
  const mix = b.vehicleMix
  if (!mix || [mix.car, mix.van, mix.truck].some((n) => !Number.isFinite(n) || n < 0) ||
      mix.car + mix.van + mix.truck <= 0) throw new RangeError('vehicleMix must contain non-negative weights with a positive total')
  if (!(b.levelDurationSec > 0)) throw new RangeError('levelDurationSec must be positive')
  if (!(b.minSpawnIntervalSec > 0)) throw new RangeError('minSpawnIntervalSec must be positive')
  if (b.blockedTolerance >= 1) throw new RangeError('blockedTolerance must be below 1')
  if (!(b.pendingReference > 0)) throw new RangeError('pendingReference must be positive')
  if (!(b.warningThreshold <= b.criticalThreshold && b.criticalThreshold <= b.congestionLimit)) {
    throw new RangeError('thresholds must satisfy warning <= critical <= limit')
  }
  return Object.freeze(b)
}

/** Spawn interval at the start of `level` (1-based). */
export function levelStartInterval(balance: BalanceConfig, level: number): number {
  return Math.max(balance.minSpawnIntervalSec, balance.baseSpawnIntervalSec * balance.levelSpawnFactor ** (level - 1))
}

/** Spawn interval `elapsedSec` into `level`: linear ramp, clamped to the minimum. */
export function spawnIntervalAt(balance: BalanceConfig, level: number, elapsedSec: number): number {
  const start = levelStartInterval(balance, level)
  const progress = Math.min(1, Math.max(0, elapsedSec / balance.levelDurationSec))
  const interval = start * (1 - (1 - balance.inLevelRampFactor) * progress)
  return Math.max(balance.minSpawnIntervalSec, interval)
}

/** Normalized class mix for a level; heavier traffic grows at a controlled rate. */
export function vehicleMixFor(balance: BalanceConfig, level: number): VehicleMix {
  const van = Math.min(0.45, balance.vehicleMix.van + balance.vansPerLevel * Math.max(0, level - 1))
  const truck = Math.min(0.3, balance.vehicleMix.truck + balance.trucksPerLevel * Math.max(0, level - 1))
  const car = Math.max(0, 1 - van - truck)
  return { car, van, truck }
}

export function maxVehiclesFor(balance: BalanceConfig, level: number): number {
  return Math.min(200, balance.maxVehicles + balance.maxVehiclesPerLevel * Math.max(0, level - 1))
}

export function startingVehiclesFor(balance: BalanceConfig, level: number): number {
  return Math.min(balance.maxVehicles, balance.startingVehicles + balance.startingVehiclesPerLevel * (level - 1))
}
