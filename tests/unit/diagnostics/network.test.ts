import { describe, expect, it } from 'vitest'
import { NetworkMonitor } from '../../../src/game/diagnostics'
import { RoadGraph } from '../../../src/game/roads'
import { TrafficSim, type RandomSource, type TrafficSim as Sim, type Vehicle, type VehicleState } from '../../../src/game/sim'
import { GameSession } from '../../../src/game'

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

/** Portal 0 — 1 — 2 portal: edge 0 is 0–1 (4 tiles), edge 1 is 1–2 (4 tiles). */
function corridor(): RoadGraph {
  return RoadGraph.fromLayout({
    nodes: [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 4, y: 0 },
      { id: 2, x: 8, y: 0 },
    ],
    segments: [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
    ],
  })
}

interface FakeVehicle {
  id: number
  edge: number
  from: number
  to: number
  state: VehicleState
  waitingFor?: number
  waitTime?: number
  spawnedAt?: number
}

/**
 * A scripted stand-in for TrafficSim exposing only what the monitor reads,
 * so each metric can be checked against hand-computed values.
 */
class FakeSim {
  readonly minGap = 1
  time = 0
  fleet: FakeVehicle[] = []

  vehicles(): Vehicle[] {
    return this.fleet.map((f) => ({
      id: f.id,
      kind: 'car',
      origin: f.from,
      destination: f.to,
      steps: [{ edge: f.edge, from: f.from, to: f.to }],
      stepIndex: 0,
      progress: 0,
      speed: f.state === 'moving' ? 1 : 0,
      state: f.state,
      waitTime: f.waitTime ?? 0,
      waitingFor: f.waitingFor ?? 0,
      spawnedAt: f.spawnedAt ?? 0,
    }))
  }

  stats() {
    return { time: this.time }
  }

  /** Front first: lower ids are further ahead. */
  laneOccupants(edge: number, from: number): Vehicle[] {
    return this.vehicles()
      .filter((v) => v.steps[0]!.edge === edge && v.steps[0]!.from === from)
      .sort((a, b) => a.id - b.id)
  }

  advance(seconds: number, monitor: NetworkMonitor): void {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      this.time += DT
      monitor.observe(DT)
    }
  }
}

function fake(graph = corridor()) {
  const sim = new FakeSim()
  const monitor = new NetworkMonitor(graph, sim as unknown as Sim)
  return { graph, sim, monitor }
}

describe('NetworkMonitor journeys and throughput', () => {
  it('counts a vehicle that leaves the fleet as a completed journey with its travel and waiting time', () => {
    const { sim, monitor } = fake()
    sim.fleet = [{ id: 1, edge: 0, from: 0, to: 1, state: 'moving', spawnedAt: 0, waitTime: 0 }]
    sim.advance(5, monitor)
    sim.fleet[0]!.waitTime = 1.5
    sim.advance(1, monitor)
    expect(monitor.stats().completedJourneys).toBe(0)
    expect(monitor.stats().averageTravelSec).toBeUndefined()
    sim.fleet = []
    sim.advance(DT, monitor)
    const s = monitor.stats()
    expect(s.completedJourneys).toBe(1)
    expect(s.averageTravelSec).toBeCloseTo(6 + DT)
    expect(s.averageWaitSec).toBeCloseTo(1.5)
    expect(s.activeVehicles).toBe(0)
  })

  it('withholds throughput until 15 s have passed, then reports journeys per minute over the last 60 s', () => {
    const { sim, monitor } = fake()
    sim.fleet = [{ id: 1, edge: 0, from: 0, to: 1, state: 'moving' }]
    sim.advance(1, monitor)
    sim.fleet = []
    sim.advance(1, monitor)
    expect(monitor.stats().throughputPerMin).toBeUndefined()
    sim.advance(18, monitor) // 20 s elapsed, 1 exit
    expect(monitor.stats().throughputPerMin).toBeCloseTo(3)
    sim.advance(40, monitor) // 60 s elapsed
    expect(monitor.stats().throughputPerMin).toBeCloseTo(1)
    sim.advance(5, monitor) // the exit at t≈1 s has left the window
    expect(monitor.stats().throughputPerMin).toBe(0)
  })
})

describe('NetworkMonitor road heat', () => {
  it('ignores moving traffic and rises towards the queue occupancy of the fuller lane', () => {
    const { sim, monitor } = fake()
    sim.fleet = [
      { id: 1, edge: 0, from: 0, to: 1, state: 'moving' },
      { id: 2, edge: 0, from: 0, to: 1, state: 'moving' },
    ]
    sim.advance(5, monitor)
    expect(monitor.heatOf(0)).toBe(0)

    // Two stopped cars × 1 tile spacing on a 4-tile lane = 0.5 occupancy.
    sim.fleet = [
      { id: 1, edge: 0, from: 0, to: 1, state: 'waiting' },
      { id: 2, edge: 0, from: 0, to: 1, state: 'waiting' },
      { id: 3, edge: 0, from: 1, to: 0, state: 'waiting' },
    ]
    sim.advance(4, monitor) // one time constant
    expect(monitor.heatOf(0)).toBeCloseTo(0.5 * (1 - Math.exp(-1)), 3)
    sim.advance(40, monitor)
    expect(monitor.heatOf(0)).toBeCloseTo(0.5, 3)
    expect(monitor.heatOf(1)).toBe(0)
  })

  it('caps occupancy at 1 and decays once the queue clears', () => {
    const { sim, monitor } = fake()
    sim.fleet = [1, 2, 3, 4, 5, 6].map((id) => ({ id, edge: 1, from: 1, to: 2, state: 'waiting' as const }))
    sim.advance(60, monitor)
    expect(monitor.heatOf(1)).toBeCloseTo(1, 3)
    sim.fleet = []
    sim.advance(4, monitor)
    expect(monitor.heatOf(1)).toBeCloseTo(Math.exp(-1), 2)
    sim.advance(60, monitor)
    expect(monitor.roads()).toEqual([])
  })

  it('marks a road as a persistent bottleneck only after 8 s at half full or more', () => {
    const { sim, monitor } = fake()
    sim.fleet = [1, 2, 3, 4].map((id) => ({ id, edge: 0, from: 0, to: 1, state: 'waiting' as const }))
    // Heat crosses 0.5 after 4·ln(2) ≈ 2.77 s, so the road becomes persistent near 10.8 s.
    sim.advance(10, monitor)
    expect(monitor.roads()[0]).toMatchObject({ edge: 0, persistent: false })
    expect(monitor.stats().bottlenecks).toBe(0)
    sim.advance(1.5, monitor)
    expect(monitor.roads()[0]).toMatchObject({ edge: 0, persistent: true })
    expect(monitor.stats().bottlenecks).toBe(1)
  })

  it('carries heat onto both halves when a road is split by construction', () => {
    const graph = corridor()
    const { sim, monitor } = fake(graph)
    sim.fleet = [1, 2, 3, 4].map((id) => ({ id, edge: 0, from: 0, to: 1, state: 'waiting' as const }))
    sim.advance(20, monitor)
    const before = monitor.heatOf(0)
    const { split } = graph.ensureNodeAt({ kind: 'edge', edge: 0, t: 0.5 })
    monitor.applySplit(split!)
    expect(monitor.heatOf(0)).toBe(0)
    expect(monitor.heatOf(split!.towardA)).toBeCloseTo(before)
    expect(monitor.heatOf(split!.towardB)).toBeCloseTo(before)
  })
})

describe('NetworkMonitor blocked junctions', () => {
  it('reports the node ahead of a lane-front vehicle that has not moved for 2 s', () => {
    const { sim, monitor } = fake()
    sim.fleet = [
      { id: 1, edge: 0, from: 0, to: 1, state: 'waiting', waitingFor: 1.9 },
      // Not at the front of its lane, so it does not mark node 1.
      { id: 2, edge: 0, from: 0, to: 1, state: 'waiting', waitingFor: 5 },
    ]
    sim.advance(DT, monitor)
    expect(monitor.blockedJunctions()).toEqual([])
    sim.fleet[0]!.waitingFor = 2
    sim.advance(DT, monitor)
    expect(monitor.blockedJunctions()).toEqual([1])
    expect(monitor.stats().blockedJunctions).toBe(1)
    sim.fleet[0]!.state = 'moving'
    sim.advance(DT, monitor)
    expect(monitor.blockedJunctions()).toEqual([])
  })
})

describe('NetworkMonitor with the real simulation', () => {
  function run(withMonitor: boolean) {
    const graph = corridor()
    const sim = new TrafficSim(graph, { portals: [0, 2], random: rng(7), startingVehicles: 6, spawnIntervalSec: 1.5 })
    const monitor = withMonitor ? new NetworkMonitor(graph, sim) : undefined
    for (let i = 0; i < 20 * 60; i++) {
      sim.step(DT)
      monitor?.observe(DT)
    }
    return { sim, monitor }
  }

  it('agrees with the simulation on journeys and active vehicles', () => {
    const { sim, monitor } = run(true)
    const s = monitor!.stats()
    expect(sim.stats().totalExited).toBeGreaterThan(10)
    expect(s.completedJourneys).toBe(sim.stats().totalExited)
    expect(s.activeVehicles).toBe(sim.stats().active)
    expect(s.waitingVehicles).toBe(sim.stats().waiting + sim.stats().stuck)
    // Two 4-tile edges at 2 tiles/s: no trip can beat 4 s.
    expect(s.averageTravelSec!).toBeGreaterThanOrEqual(4)
    expect(s.averageWaitSec!).toBeGreaterThanOrEqual(0)
    expect(s.averageWaitSec!).toBeLessThan(s.averageTravelSec!)
  })

  it('does not change simulation behaviour', () => {
    const a = run(true).sim
    const b = run(false).sim
    expect(JSON.stringify(a.vehicles())).toBe(JSON.stringify(b.vehicles()))
    expect(a.stats()).toEqual(b.stats())
  })

  it('is exposed through the session snapshot and reset with each level', () => {
    const s = new GameSession({ seed: 42 })
    s.start()
    for (let i = 0; i < 20 * 40; i++) s.tick(DT)
    const network = s.snapshot().network
    expect(network.elapsedSec).toBeCloseTo(40)
    expect(network.activeVehicles).toBe(s.snapshot().activeVehicles)
    expect(network.completedJourneys).toBe(s.sim.stats().totalExited)
    expect(network.throughputPerMin).toBeDefined()
    s.restart()
    expect(s.snapshot().network.completedJourneys).toBe(0)
    expect(s.snapshot().network.elapsedSec).toBe(0)
  })
})
