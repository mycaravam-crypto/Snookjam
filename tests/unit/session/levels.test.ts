import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BALANCE,
  DEFAULT_LEVEL_TRAFFIC,
  createBalance,
  levelProfile,
  levelTraffic,
  mixShares,
  validateLevelTraffic,
} from '../../../src/game'

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8]
const profiles = LEVELS.map((l) => levelProfile(DEFAULT_BALANCE, l))
const heavy = (level: number) => mixShares(levelProfile(DEFAULT_BALANCE, level).mix).truck
const nonCar = (level: number) => 1 - mixShares(levelProfile(DEFAULT_BALANCE, level).mix).car

describe('difficulty curve', () => {
  it('starts forgiving: level 1 is cars only with a modest cap', () => {
    expect(profiles[0]).toMatchObject({ level: 1, mix: { car: 1, van: 0, truck: 0 } })
    expect(profiles[0]!.maxVehicles).toBeLessThan(DEFAULT_BALANCE.maxVehicles)
    expect(heavy(2)).toBe(0) // no trucks until level 3
  })

  it('never eases pressure from one level to the next', () => {
    for (let i = 1; i < profiles.length; i++) {
      const [prev, next] = [profiles[i - 1]!, profiles[i]!]
      expect(next.spawnStartSec).toBeLessThanOrEqual(prev.spawnStartSec)
      expect(next.spawnEndSec).toBeLessThanOrEqual(prev.spawnEndSec)
      expect(next.maxVehicles).toBeGreaterThanOrEqual(prev.maxVehicles)
      expect(next.startingVehicles).toBeGreaterThanOrEqual(prev.startingVehicles)
      expect(heavy(next.level)).toBeGreaterThanOrEqual(heavy(prev.level))
      expect(nonCar(next.level)).toBeGreaterThanOrEqual(nonCar(prev.level))
    }
  })

  it('increases gradually, without abrupt spikes', () => {
    for (let i = 1; i < profiles.length; i++) {
      const [prev, next] = [profiles[i - 1]!, profiles[i]!]
      expect(next.spawnStartSec / prev.spawnStartSec).toBeGreaterThanOrEqual(0.7)
      expect(heavy(next.level) - heavy(prev.level)).toBeLessThanOrEqual(0.1)
      expect(nonCar(next.level) - nonCar(prev.level)).toBeLessThanOrEqual(0.16)
      expect(next.maxVehicles - prev.maxVehicles).toBeLessThanOrEqual(25)
      expect(next.startingVehicles - prev.startingVehicles).toBeLessThanOrEqual(DEFAULT_BALANCE.startingVehiclesPerLevel)
    }
  })

  it('reaches the full target in later levels and then holds steady', () => {
    const last = profiles.at(-1)!
    expect(last.maxVehicles).toBe(DEFAULT_BALANCE.maxVehicles)
    expect(last.spawnEndSec).toBe(DEFAULT_BALANCE.minSpawnIntervalSec)
    expect(levelTraffic(50)).toBe(DEFAULT_LEVEL_TRAFFIC.at(-1))
  })

  it('respects the global vehicle cap and keeps starting traffic under the level cap', () => {
    const tight = createBalance({ maxVehicles: 30, startingVehicles: 25, startingVehiclesPerLevel: 10 })
    for (const level of LEVELS) {
      const p = levelProfile(tight, level)
      expect(p.maxVehicles).toBeLessThanOrEqual(30)
      expect(p.startingVehicles).toBeLessThanOrEqual(p.maxVehicles)
    }
  })

  it('accepts a custom table and validates it', () => {
    const table = [{ mix: { car: 1, van: 1, truck: 1 }, maxVehicles: 10 }]
    validateLevelTraffic(table)
    expect(levelProfile(DEFAULT_BALANCE, 3, table)).toMatchObject({ maxVehicles: 10 })
    expect(() => validateLevelTraffic([])).toThrow()
    expect(() => validateLevelTraffic([{ mix: { car: 0, van: 0, truck: 0 }, maxVehicles: 10 }])).toThrow()
    expect(() => validateLevelTraffic([{ mix: { car: 1, van: 0, truck: 0 }, maxVehicles: 0 }])).toThrow()
    expect(() => levelTraffic(0)).toThrow()
    validateLevelTraffic(DEFAULT_LEVEL_TRAFFIC)
  })
})
