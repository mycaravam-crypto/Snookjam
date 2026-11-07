/**
 * Vehicle following, braking and queue behaviour (#31).
 */
import { describe, expect, it } from 'vitest'
import { RoadGraph } from '../../../src/game/roads'
import { nextSpeed, TrafficSim, vehicleFollowingGap, VEHICLE_PROFILES, type RandomSource, type Vehicle } from '../../../src/game/sim'

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

/** Portal 0 — 1 — 2 portal: a 12-tile approach and a 4-tile exit road. */
function corridor(): RoadGraph {
  return RoadGraph.fromLayout({
    nodes: [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 12, y: 0 },
      { id: 2, x: 16, y: 0 },
    ],
    segments: [
      { from: 0, to: 1, capacity: 20 },
      { from: 1, to: 2, capacity: 20 },
    ],
  })
}

/** Same-lane pairs that are closer than their following gap (should be none). */
function overlaps(sim: TrafficSim, graph: RoadGraph): string[] {
  const bad: string[] = []
  for (const edge of graph.edges()) {
    for (const from of [edge.a, edge.b]) {
      const lane = sim.laneOccupants(edge.id, from)
      for (let i = 1; i < lane.length; i++) {
        const leader = lane[i - 1]!
        const follower = lane[i]!
        const gap = leader.progress - follower.progress
        if (gap < vehicleFollowingGap(follower.kind, leader.kind) - 1e-6) bad.push(`${follower.id} behind ${leader.id}: ${gap.toFixed(3)}`)
      }
    }
  }
  return bad
}

/** Steps the sim, recording each vehicle's speed history. */
function record(sim: TrafficSim, seconds: number, history: Map<number, Vehicle[]>, check?: () => void): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    sim.step(DT)
    for (const v of sim.vehicles()) {
      const list = history.get(v.id) ?? []
      list.push(v)
      history.set(v.id, list)
    }
    check?.()
  }
}

describe('nextSpeed (#31)', () => {
  it('accelerates toward the cruising speed', () => {
    expect(nextSpeed(0, 2, 100, 4, 6, DT)).toBeCloseTo(0.2)
    expect(nextSpeed(1.9, 2, 100, 4, 6, DT)).toBe(2)
  })

  it('brakes so it can stop within the room ahead', () => {
    expect(nextSpeed(2, 2, 0.12, 4, 6, DT)).toBeCloseTo(Math.sqrt(2 * 6 * 0.12))
    expect(nextSpeed(2, 2, 0.01, 4, 6, DT)).toBeCloseTo(0.01 / DT)
    expect(nextSpeed(2, 2, 0, 4, 6, DT)).toBe(0)
    expect(nextSpeed(2, 2, -1, 4, 6, DT)).toBe(0)
  })
})

describe('following and braking (#31)', () => {
  it('brakes smoothly to a stop when the road ahead closes, then pulls away smoothly', () => {
    const graph = corridor()
    const sim = new TrafficSim(graph, { portals: [0, 2], random: { next: () => 0 }, startingVehicles: 1, spawnIntervalSec: 1000 })
    const history = new Map<number, Vehicle[]>()
    record(sim, 2, history)
    const exitRoad = graph.edges().find((e) => e.a === 1 && e.b === 2)!.id
    graph.setBlocked(exitRoad, true)
    record(sim, 6, history)
    const [id] = [...history.keys()]
    const v = sim.getVehicle(id!)!
    // Stopped at the end of the approach road, not past it.
    expect(v.stepIndex).toBe(0)
    expect(v.speed).toBe(0)
    expect(v.progress).toBeLessThanOrEqual(12 + 1e-9)
    expect(v.progress).toBeGreaterThan(11.9)
    graph.setBlocked(exitRoad, false)
    record(sim, 10, history)
    expect(sim.stats().totalExited).toBe(1)
    const speeds = history.get(id!)!.map((x) => x.speed)
    const { accel, decel } = VEHICLE_PROFILES[v.kind]
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]! - speeds[i - 1]!).toBeLessThanOrEqual(accel * DT + 1e-9)
      expect(speeds[i - 1]! - speeds[i]!).toBeLessThanOrEqual(decel * DT * 1.25)
    }
  })
})

describe('queues with mixed vehicles (#31)', () => {
  function queued(seed: number) {
    const graph = corridor()
    const sim = new TrafficSim(graph, {
      portals: [0, 2],
      random: rng(seed),
      startingVehicles: 4,
      spawnIntervalSec: 0.8,
      minSpawnIntervalSec: 0.8,
      vehicleMix: { car: 1, van: 1, truck: 1 },
    })
    const exitRoad = graph.edges().find((e) => e.a === 1 && e.b === 2)!.id
    return { graph, sim, exitRoad }
  }

  it.each([1, 2, 3])('forms and dissolves a queue without overlap or stop-go waves (seed %i)', (seed) => {
    const { graph, sim, exitRoad } = queued(seed)
    const history = new Map<number, Vehicle[]>()
    const bad: string[] = []
    const check = () => bad.push(...overlaps(sim, graph))
    // Fill the approach, then close the exit road (spawns that cannot route
    // are dropped, so traffic must be on the road before it closes).
    record(sim, 8, history, check)
    graph.setBlocked(exitRoad, true)
    record(sim, 10, history, check)
    // A queue has formed back from the closed road.
    const queue = sim.vehicles().filter((v) => v.state !== 'moving')
    expect(queue.length).toBeGreaterThan(4)
    expect(new Set(queue.map((v) => v.kind)).size).toBeGreaterThan(1)

    const releasedAt = new Map<number, number>()
    for (const [id, list] of history) releasedAt.set(id, list.length)
    graph.setBlocked(exitRoad, false)
    record(sim, 40, history, check)
    expect(bad).toEqual([])

    for (const [id, list] of history) {
      const after = list.slice(releasedAt.get(id) ?? 0)
      let stops = 0
      for (let i = 1; i < after.length; i++) if (after[i - 1]!.speed > 0 && after[i]!.speed === 0) stops++
      // Once the queue starts moving, a vehicle stops again at most once
      // (behind a slower-accelerating vehicle), never repeatedly.
      expect(stops, `vehicle ${id}`).toBeLessThanOrEqual(1)
    }
  })

  it('propagates braking upstream: vehicles slow before reaching the queue', () => {
    const { graph, sim, exitRoad } = queued(4)
    const history = new Map<number, Vehicle[]>()
    record(sim, 8, history)
    graph.setBlocked(exitRoad, true)
    record(sim, 10, history)
    for (const list of history.values()) {
      const { decel } = VEHICLE_PROFILES[list[0]!.kind]
      // Skip the first step, where a vehicle enters from the tunnel.
      for (let i = 2; i < list.length; i++) {
        expect(list[i - 1]!.speed - list[i]!.speed).toBeLessThanOrEqual(decel * DT * 1.25)
      }
    }
  })

  it('is deterministic for a fixed seed and step sequence', () => {
    const a = queued(5)
    const b = queued(5)
    for (const s of [a, b]) {
      s.graph.setBlocked(s.exitRoad, true)
      for (let i = 0; i < 400; i++) s.sim.step(DT)
      s.graph.setBlocked(s.exitRoad, false)
      for (let i = 0; i < 400; i++) s.sim.step(DT)
    }
    expect(JSON.stringify(a.sim.vehicles())).toBe(JSON.stringify(b.sim.vehicles()))
  })
})
