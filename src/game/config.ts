/**
 * Framework-independent game configuration.
 *
 * These are the MVP tuning defaults from the roadmap (#1). They are plain data
 * so simulation code can be tested without Vue or Canvas, and so later issues
 * can override them per level instead of scattering constants.
 */
export interface GameConfig {
  /** Logical map width in tiles. */
  readonly mapWidth: number
  /** Logical map height in tiles. */
  readonly mapHeight: number
  /** Vehicles present when a level starts. */
  readonly startingVehicles: number
  /** Maximum simultaneously active vehicles. */
  readonly maxVehicles: number
  /** Seconds between spawns at the start of a level. */
  readonly initialSpawnIntervalSec: number
  /** Lower bound for the spawn interval as pressure increases. */
  readonly minSpawnIntervalSec: number
  /** Fixed simulation update rate. */
  readonly simulationHz: number
  /** Congestion percentage at which the run ends. */
  readonly congestionLimit: number
  /** Seconds a player must survive to complete a level. */
  readonly levelDurationSec: number
}

export const DEFAULT_CONFIG: GameConfig = Object.freeze({
  mapWidth: 40,
  mapHeight: 30,
  startingVehicles: 8,
  maxVehicles: 100,
  initialSpawnIntervalSec: 4,
  minSpawnIntervalSec: 0.8,
  simulationHz: 20,
  congestionLimit: 100,
  levelDurationSec: 180,
})

/** Creates a config from the defaults with selected overrides. */
export function createConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  const config = { ...DEFAULT_CONFIG, ...overrides }
  validateConfig(config)
  return Object.freeze(config)
}

/** Throws if a config value would make the game unplayable. */
export function validateConfig(config: GameConfig): void {
  const positive: (keyof GameConfig)[] = [
    'mapWidth',
    'mapHeight',
    'maxVehicles',
    'initialSpawnIntervalSec',
    'minSpawnIntervalSec',
    'simulationHz',
    'congestionLimit',
    'levelDurationSec',
  ]
  for (const key of positive) {
    const value = config[key]
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${key} must be a positive number, got ${value}`)
    }
  }
  if (!Number.isInteger(config.startingVehicles) || config.startingVehicles < 0) {
    throw new RangeError('startingVehicles must be a non-negative integer')
  }
  if (config.startingVehicles > config.maxVehicles) {
    throw new RangeError('startingVehicles cannot exceed maxVehicles')
  }
  if (config.minSpawnIntervalSec > config.initialSpawnIntervalSec) {
    throw new RangeError('minSpawnIntervalSec cannot exceed initialSpawnIntervalSec')
  }
}

/** Duration of one fixed simulation step in seconds. */
export function stepDurationSec(config: GameConfig): number {
  return 1 / config.simulationHz
}
