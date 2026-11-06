import { describe, expect, it } from 'vitest'
import { createConfig, DEFAULT_CONFIG, stepDurationSec } from '@game/config'

describe('game config', () => {
  it('uses the MVP defaults', () => {
    expect(DEFAULT_CONFIG).toMatchObject({
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
    expect(stepDurationSec(DEFAULT_CONFIG)).toBeCloseTo(0.05)
  })

  it('applies overrides without mutating the defaults', () => {
    const config = createConfig({ maxVehicles: 50 })
    expect(config.maxVehicles).toBe(50)
    expect(DEFAULT_CONFIG.maxVehicles).toBe(100)
  })

  it('rejects invalid values', () => {
    expect(() => createConfig({ simulationHz: 0 })).toThrow(RangeError)
    expect(() => createConfig({ startingVehicles: 200 })).toThrow(RangeError)
    expect(() => createConfig({ minSpawnIntervalSec: 10 })).toThrow(RangeError)
  })
})
