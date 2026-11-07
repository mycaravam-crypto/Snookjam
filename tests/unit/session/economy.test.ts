/**
 * Score, coins, the shop and roundabouts.
 */
import { describe, expect, it } from 'vitest'
import {
  createEconomy,
  DEFAULT_ECONOMY,
  exitReward,
  GameSession,
  levelReward,
  RoadGraph,
  shopItems,
  TrafficSim,
  type RandomSource,
} from '../../../src/game'
import { collisions } from '../sim/footprint'

const DT = 1 / 20

function rng(seed: number): RandomSource {
  let state = seed >>> 0
  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

/** A four-way crossroads at node 4 with a tunnel at the end of each arm. */
function plus(): RoadGraph {
  return RoadGraph.fromLayout({
    nodes: [
      { id: 0, x: 8, y: 0 },
      { id: 1, x: 16, y: 8 },
      { id: 2, x: 8, y: 16 },
      { id: 3, x: 0, y: 8 },
      { id: 4, x: 8, y: 8 },
    ],
    segments: [
      { from: 0, to: 4 },
      { from: 1, to: 4 },
      { from: 2, to: 4 },
      { from: 3, to: 4 },
    ],
  })
}

const busyPlus = (seed = 1) =>
  new TrafficSim(plus(), {
    portals: [0, 1, 2, 3],
    random: rng(seed),
    startingVehicles: 8,
    spawnIntervalSec: 0.7,
    minSpawnIntervalSec: 0.7,
    junctionClearSec: 1.8,
  })

describe('rewards', () => {
  it('pays coins and points per vehicle through', () => {
    expect(exitReward(DEFAULT_ECONOMY, 3)).toEqual({ coins: 3, points: 30 })
  })

  it('pays a bigger level bonus on later levels and calmer roads', () => {
    const calm = levelReward(DEFAULT_ECONOMY, 1, 0)
    const busy = levelReward(DEFAULT_ECONOMY, 1, 90)
    const later = levelReward(DEFAULT_ECONOMY, 3, 0)
    expect(calm.coins).toBeGreaterThan(busy.coins)
    expect(later.coins).toBeGreaterThan(calm.coins)
    expect(calm.points).toBe(calm.coins * DEFAULT_ECONOMY.pointsPerBonusCoin)
  })

  it('rejects invalid tuning and lists both shop items', () => {
    expect(() => createEconomy({ signalPrice: -1 })).toThrow(RangeError)
    expect(shopItems(DEFAULT_ECONOMY).map((i) => i.id)).toEqual(['signal', 'roundabout'])
  })
})

describe('roundabouts in the simulation', () => {
  it('places, refuses on lit junctions and removes', () => {
    const sim = busyPlus()
    expect(sim.placeRoundabout(0)).toBe(false) // tunnel
    expect(sim.placeRoundabout(4)).toBe(true)
    expect(sim.roundabouts().map((j) => j.key)).toEqual([4])
    expect(sim.placeSignal(4)).toBe(false)
    expect(sim.removeRoundabout(4)).toBe(true)
    expect(sim.removeRoundabout(4)).toBe(false)
    expect(sim.placeSignal(4)).toBe(true)
    expect(sim.placeRoundabout(4)).toBe(false)
  })

  it('carries more traffic through a busy junction, without collisions', () => {
    const run = (roundabout: boolean) => {
      const sim = busyPlus(3)
      if (roundabout) sim.placeRoundabout(4)
      for (let i = 0; i < 20 * 90; i++) {
        sim.step(DT)
        if (roundabout && i % 4 === 0) expect(collisions(sim)).toEqual([])
      }
      return sim.stats().totalExited
    }
    const plain = run(false)
    const round = run(true)
    expect(round).toBeGreaterThan(plain * 1.3)
  })
})

describe('the shop in a game session', () => {
  const lit = (s: GameSession) => s.sim.junctions().find((j) => s.sim.isSignalJunction(j))!

  it('earns coins and score as vehicles get through', () => {
    const s = new GameSession({ seed: 42 })
    s.start()
    const before = s.snapshot()
    expect(before.coins).toBe(DEFAULT_ECONOMY.startingCoins)
    for (let i = 0; i < 20 * 60; i++) s.tick(DT)
    const after = s.snapshot()
    expect(after.vehiclesExited).toBeGreaterThan(0)
    expect(after.coins - before.coins).toBe(after.vehiclesExited * DEFAULT_ECONOMY.coinsPerExit)
    expect(after.score).toBe(after.vehiclesExited * DEFAULT_ECONOMY.pointsPerExit)
  })

  it('buys into the inventory, places from it and refunds on removal', () => {
    const s = new GameSession({ seed: 9, economy: { startingCoins: 20 } })
    expect(s.buy('signal')).toBe(false) // not started
    s.start()
    expect(s.buy('roundabout')).toBe(false) // 40 > 20
    expect(s.buy('signal')).toBe(true)
    expect(s.snapshot()).toMatchObject({ coins: 5, inventory: { signal: 1, roundabout: 0 } })
    const j = lit(s)
    expect(s.placeRoundabout(j.key)).toBe(false) // none owned
    expect(s.placeSignal(j.key)).toBe(true)
    expect(s.placeSignal(j.key, { greenSec: 5 })).toBe(true) // re-timing is free
    expect(s.snapshot()).toMatchObject({ inventory: { signal: 0 }, placed: { signal: 1 } })
    expect(s.removeSignal(j.key)).toBe(true)
    expect(s.snapshot()).toMatchObject({ inventory: { signal: 1 }, placed: { signal: 0 } })

    s.grantCoinsForTesting(100)
    expect(s.buy('roundabout')).toBe(true)
    expect(s.placeRoundabout(j.key)).toBe(true)
    expect(s.placeRoundabout(j.key)).toBe(false) // already there
    expect(s.snapshot()).toMatchObject({ inventory: { roundabout: 0 }, placed: { roundabout: 1 } })
  })

  it('pays a level bonus and returns placed items on the next level; restart resets', () => {
    const s = new GameSession({ seed: 9, balance: { levelDurationSec: 20 } })
    s.start()
    s.buy('signal')
    s.placeSignal(lit(s).key)
    for (let i = 0; i < 20 * 20; i++) s.tick(DT)
    expect(s.state).toBe('levelComplete')
    const done = s.snapshot()
    expect(done.levelReward!.coins).toBeGreaterThan(0)
    expect(s.nextLevel()).toBe(true)
    expect(s.snapshot()).toMatchObject({ inventory: { signal: 1 }, placed: { signal: 0 }, levelReward: undefined })
    expect(s.sim.signals()).toHaveLength(0)
    s.restart()
    expect(s.snapshot()).toMatchObject({ score: 0, coins: DEFAULT_ECONOMY.startingCoins, inventory: { signal: 0, roundabout: 0 } })
  })
})
