/**
 * Per-level traffic profiles (#23): one explicit, documented difficulty
 * curve combining spawn frequency, vehicle mix and an active-vehicle cap.
 *
 * Spawn intervals come from the existing balance ramp (balance.ts). This
 * module adds what varies by level beyond that: which vehicles appear and how
 * many may be on the map at once. Pressure rises in small steps; no level
 * changes more than one lever sharply.
 *
 *   level  mix (car/van/truck)  heavy share  active cap
 *   1      100 /  0 /  0          0 %          40
 *   2       85 / 15 /  0          0 %          55
 *   3       75 / 17 /  8          8 %          80
 *   4       67 / 20 / 13         13 %         100
 *   5+      60 / 22 / 18         18 %         100
 *
 * "Heavy share" is trucks only; vans are mid-size. The caps sit above the
 * peak fleet sizes measured over 10 seeds when each level is played without
 * building roads (24, 40, 73, 99, 98 for levels 1–5, before vehicle classes),
 * so they stop runaway spawning without being the reason a level is easy.
 * Re-measure after changing traffic rules.
 */
import { CARS_ONLY, validateMix, type VehicleMix } from '../sim/vehicleClasses'
import { spawnIntervalAt, startingVehiclesFor, type BalanceConfig } from './balance'

export interface LevelTraffic {
  readonly mix: VehicleMix
  /** Upper bound on simultaneously active vehicles for this level. */
  readonly maxVehicles: number
}

export interface LevelProfile extends LevelTraffic {
  readonly level: number
  readonly spawnStartSec: number
  readonly spawnEndSec: number
  readonly startingVehicles: number
}

/** Index 0 is level 1; the last entry repeats for all later levels. */
export const DEFAULT_LEVEL_TRAFFIC: readonly LevelTraffic[] = Object.freeze([
  { mix: CARS_ONLY, maxVehicles: 40 },
  { mix: { car: 85, van: 15, truck: 0 }, maxVehicles: 55 },
  { mix: { car: 75, van: 17, truck: 8 }, maxVehicles: 80 },
  { mix: { car: 67, van: 20, truck: 13 }, maxVehicles: 100 },
  { mix: { car: 60, van: 22, truck: 18 }, maxVehicles: 100 },
])

export function validateLevelTraffic(table: readonly LevelTraffic[]): void {
  if (table.length === 0) throw new RangeError('level traffic table must not be empty')
  for (const entry of table) {
    validateMix(entry.mix)
    if (!Number.isInteger(entry.maxVehicles) || entry.maxVehicles < 1) {
      throw new RangeError('maxVehicles must be a positive integer')
    }
  }
}

export function levelTraffic(level: number, table: readonly LevelTraffic[] = DEFAULT_LEVEL_TRAFFIC): LevelTraffic {
  if (!Number.isInteger(level) || level < 1) throw new RangeError(`invalid level ${level}`)
  return table[Math.min(level, table.length) - 1]!
}

/** Everything that defines traffic pressure for `level`, in one place. */
export function levelProfile(
  balance: BalanceConfig,
  level: number,
  table: readonly LevelTraffic[] = DEFAULT_LEVEL_TRAFFIC,
): LevelProfile {
  const traffic = levelTraffic(level, table)
  const maxVehicles = Math.min(balance.maxVehicles, traffic.maxVehicles)
  return {
    level,
    mix: traffic.mix,
    maxVehicles,
    spawnStartSec: spawnIntervalAt(balance, level, 0),
    spawnEndSec: spawnIntervalAt(balance, level, balance.levelDurationSec),
    startingVehicles: Math.min(maxVehicles, startingVehiclesFor(balance, level)),
  }
}
