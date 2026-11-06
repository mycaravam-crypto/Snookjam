import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BALANCE,
  congestionLevel,
  congestionTerms,
  createBalance,
  levelStartInterval,
  nextCongestion,
  spawnIntervalAt,
  startingVehiclesFor,
  type CongestionInput,
} from '../../../src/game'

const DT = 1 / 20
const b = DEFAULT_BALANCE
const input = (over: Partial<CongestionInput> = {}): CongestionInput => ({
  active: 20,
  blocked: 0,
  pending: 0,
  exited: 0,
  levelTime: 60,
  ...over,
})

/** Applies the same input for `seconds`. */
function hold(start: number, i: CongestionInput, seconds: number): number {
  let c = start
  for (let t = 0; t < seconds / DT; t++) c = nextCongestion(c, i, b, DT)
  return c
}

describe('congestion model', () => {
  it('rises when vehicles are blocked in queues', () => {
    expect(hold(0, input({ blocked: 15 }), 5)).toBeGreaterThan(10)
  })

  it('rises with incoming pressure from blocked tunnels', () => {
    expect(hold(0, input({ pending: 6 }), 5)).toBeCloseTo(5 * (b.pendingRatePerSec - b.flowDecayPerSec), 5)
  })

  it('tolerates normal short waits at junctions', () => {
    expect(hold(10, input({ blocked: 1 }), 5)).toBeLessThan(10)
  })

  it('falls while traffic flows and vehicles exit', () => {
    expect(hold(50, input(), 10)).toBeCloseTo(50 - 10 * b.flowDecayPerSec, 5)
    expect(nextCongestion(50, input({ exited: 2 }), b, DT)).toBeCloseTo(50 - 2 * b.exitRelief - b.flowDecayPerSec * DT, 5)
  })

  it('stays within 0 and the limit', () => {
    expect(hold(5, input(), 100)).toBe(0)
    expect(hold(95, input({ blocked: 20, pending: 50 }), 100)).toBe(b.congestionLimit)
  })

  it('is normalised by fleet size, so map and traffic scale do not matter', () => {
    const small = congestionTerms(input({ active: 10, blocked: 5 }), b, DT)
    const large = congestionTerms(input({ active: 100, blocked: 50 }), b, DT)
    expect(small).toEqual(large)
    expect(congestionTerms(input({ active: 0, blocked: 0 }), b, DT).blockedShare).toBe(0)
  })

  it('cannot rise during the level-start grace period', () => {
    const jammed = input({ blocked: 20, pending: 20, levelTime: b.levelStartGraceSec - 1 })
    expect(congestionTerms(jammed, b, DT).rise).toBe(0)
    expect(nextCongestion(0, jammed, b, DT)).toBe(0)
  })

  it('reports normal, warning and critical levels', () => {
    expect(congestionLevel(0, b)).toBe('normal')
    expect(congestionLevel(b.warningThreshold, b)).toBe('warning')
    expect(congestionLevel(b.criticalThreshold, b)).toBe('critical')
  })
})

describe('balance and progression', () => {
  it('ramps spawn pressure within a level and between levels', () => {
    const l1Start = spawnIntervalAt(b, 1, 0)
    const l1End = spawnIntervalAt(b, 1, b.levelDurationSec)
    expect(l1Start).toBe(b.baseSpawnIntervalSec)
    expect(l1End).toBeCloseTo(l1Start * b.inLevelRampFactor)
    expect(spawnIntervalAt(b, 1, 90)).toBeLessThan(l1Start)
    expect(spawnIntervalAt(b, 1, 90)).toBeGreaterThan(l1End)
    expect(levelStartInterval(b, 2)).toBeCloseTo(l1Start * b.levelSpawnFactor)
    for (let level = 1; level < 10; level++) {
      expect(levelStartInterval(b, level + 1)).toBeLessThanOrEqual(levelStartInterval(b, level))
      expect(spawnIntervalAt(b, level, b.levelDurationSec)).toBeGreaterThanOrEqual(b.minSpawnIntervalSec)
    }
    expect(spawnIntervalAt(b, 20, 0)).toBe(b.minSpawnIntervalSec)
  })

  it('adds starting vehicles per level up to the cap', () => {
    expect(startingVehiclesFor(b, 1)).toBe(b.startingVehicles)
    expect(startingVehiclesFor(b, 3)).toBe(b.startingVehicles + 2 * b.startingVehiclesPerLevel)
    expect(startingVehiclesFor(b, 1000)).toBe(b.maxVehicles)
  })

  it('validates overrides', () => {
    expect(createBalance({ levelDurationSec: 60 }).levelDurationSec).toBe(60)
    expect(() => createBalance({ blockedTolerance: 1 })).toThrow()
    expect(() => createBalance({ levelDurationSec: 0 })).toThrow()
    expect(() => createBalance({ warningThreshold: 90, criticalThreshold: 80 })).toThrow()
    expect(() => createBalance({ exitRelief: -1 })).toThrow()
  })
})
