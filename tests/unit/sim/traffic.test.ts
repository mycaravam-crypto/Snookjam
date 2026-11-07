import { describe, expect, it } from 'vitest'
import { RoadGraph, type RoadLayout } from '../../../src/game/roads'
import { FixedStepClock, TrafficSim, type RandomSource, type TrafficOptions } from '../../../src/game/sim'

const DT = 1 / 20

/** Mulberry32, matching the world Rng's algorithm. */
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

/** Portal 0 — 1 — 2 portal, 4 tiles per edge. */
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

/** Four portals around a central square loop, so routes cross and queue. */
function crossroads(): { graph: RoadGraph; portals: number[] } {
  const layout: RoadLayout = {
    nodes: [
      { id: 0, x: 4, y: 0 },
      { id: 1, x: 12, y: 4 },
      { id: 2, x: 8, y: 12 },
      { id: 3, x: 0, y: 8 },
      { id: 4, x: 4, y: 4 },
      { id: 5, x: 8, y: 4 },
      { id: 6, x: 8, y: 8 },
      { id: 7, x: 4, y: 8 },
    ],
    segments: [
      { from: 0, to: 4 },
      { from: 1, to: 5 },
      { from: 2, to: 6 },
      { from: 3, to: 7 },
      { from: 4, to: 5, capacity: 2 },
      { from: 5, to: 6, capacity: 2 },
      { from: 6, to: 7, capacity: 2 },
      { from: 7, to: 4, capacity: 2 },
    ],
  }
  return { graph: RoadGraph.fromLayout(layout), portals: [0, 1, 2, 3] }
}

function sim(graph: RoadGraph, options: Partial<TrafficOptions> & { portals: number[] }): TrafficSim {
  return new TrafficSim(graph, { random: rng(1), startingVehicles: 0, spawnIntervalSec: 1000, ...options })
}

function run(s: TrafficSim, steps: number, each?: () => void): void {
  for (let i = 0; i < steps; i++) {
    s.step(DT)
    each?.()
  }
}

function snapshot(s: TrafficSim) {
  return s.vehicles().map((v) => ({ id: v.id, edge: v.steps[v.stepIndex]!.edge, p: v.progress, st: v.state, w: v.waitTime }))
}

describe('spawning', () => {
  it('spawns starting vehicles at portals with valid routes to another portal', () => {
    const { graph, portals } = crossroads()
    const s = sim(graph, { portals, startingVehicles: 8 })
    run(s, 40)
    expect(s.stats().totalSpawned).toBe(8)
    for (const v of s.vehicles()) {
      expect(portals).toContain(v.origin)
      expect(portals).toContain(v.destination)
      expect(v.destination).not.toBe(v.origin)
      expect(v.steps[0]!.from).toBe(v.origin)
      expect(v.steps.at(-1)!.to).toBe(v.destination)
      v.steps.forEach((step, i) => i > 0 && expect(step.from).toBe(v.steps[i - 1]!.to))
    }
  })

  it('spawns on the configured interval and respects the vehicle cap', () => {
    const { graph, portals } = crossroads()
    const s = sim(graph, { portals, spawnIntervalSec: 1, maxVehicles: 5 })
    run(s, 20) // 1 second
    expect(s.stats().totalSpawned).toBe(1)
    let peak = 0
    run(s, 2000, () => (peak = Math.max(peak, s.stats().active)))
    expect(peak).toBeLessThanOrEqual(5)
    expect(s.stats().totalSpawned).toBeGreaterThan(5)
  })

  it('clamps the spawn interval to the configured minimum', () => {
    const s = sim(corridor(), { portals: [0, 2], minSpawnIntervalSec: 0.8 })
    s.setSpawnInterval(0.1)
    expect(s.spawnIntervalSec).toBe(0.8)
  })

  it('holds spawns as pending while the entry lane is full', () => {
    const s = sim(corridor(), { portals: [0, 2], startingVehicles: 6 })
    s.step(DT)
    expect(s.stats()).toMatchObject({ active: 2, pendingSpawns: 4 }) // one per portal lane
  })

  it('rejects portals that are not graph nodes', () => {
    expect(() => sim(corridor(), { portals: [0, 9] })).toThrow(/portal/)
  })
})

describe('movement and exit', () => {
  it('drives along the route and exits at the destination portal', () => {
    const s = sim(corridor(), { portals: [0, 2], startingVehicles: 1 })
    s.step(DT)
    const v = s.vehicles()[0]!
    const id = v.id
    // 8 tiles at speed 2 = 4 s, plus one tick at the junction.
    run(s, 79)
    expect(s.getVehicle(id)).toBeDefined()
    run(s, 4)
    expect(s.getVehicle(id)).toBeUndefined()
    expect(s.stats()).toMatchObject({ active: 0, totalExited: 1 })
  })

  it('never overlaps or exceeds capacity in any lane', () => {
    const { graph, portals } = crossroads()
    const s = sim(graph, { portals, startingVehicles: 30, spawnIntervalSec: 0.8 })
    run(s, 1200, () => {
      for (const edge of graph.edges()) {
        for (const from of [edge.a, edge.b]) {
          const lane = s.laneOccupants(edge.id, from)
          expect(lane.length).toBeLessThanOrEqual(edge.capacity)
          for (let i = 1; i < lane.length; i++) {
            expect(lane[i - 1]!.progress - lane[i]!.progress).toBeGreaterThanOrEqual(s.minGap - 1e-6)
          }
        }
      }
    })
    expect(s.stats().totalExited).toBeGreaterThan(0)
  })

  it('waits at a full next edge and proceeds once it has room', () => {
    // Fast approach, slow single-capacity bottleneck.
    const g = RoadGraph.fromLayout({
      nodes: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 2, y: 0 },
        { id: 2, x: 6, y: 0 },
      ],
      segments: [
        { from: 0, to: 1, speedLimit: 4 },
        { from: 1, to: 2, speedLimit: 0.5, capacity: 1 },
      ],
    })
    const s = new TrafficSim(g, { portals: [0, 2], random: { next: () => 0 }, startingVehicles: 1, spawnIntervalSec: 1000 })
    // Once the lead is minGap in, portal 0 has room again for the follower.
    run(s, 1) // the starting vehicle enters
    while (s.vehicles()[0]!.stepIndex === 0 && s.vehicles()[0]!.progress < s.minGap) run(s, 1)
    s.queueSpawns(1)
    // Wait until the slow lead is a full minGap into the bottleneck; until then
    // the follower creeps up behind it across the node (#22).
    const leadIn = () => {
      const v = s.vehicles()[0]!
      return v.stepIndex === 1 && v.progress >= s.minGap + 0.1
    }
    for (let i = 0; i < 400 && !leadIn(); i++) run(s, 1)
    run(s, 20) // the fast follower reaches the junction
    const [lead, follower] = s.vehicles()
    expect(lead!.steps[lead!.stepIndex]!.edge).toBe(1)
    expect(follower!.state).toBe('waiting')
    expect(follower!.progress).toBeCloseTo(2) // queued at the junction
    run(s, 200) // lead needs 8 s to clear the bottleneck
    const f = s.getVehicle(follower!.id)!
    expect(f.stepIndex).toBe(1)
    expect(f.waitTime).toBeGreaterThan(5)
  })
})

describe('intersections', () => {
  it('lets one vehicle cross an intersection per junctionClearSec', () => {
    // T-junction at node 1 with three portals; all routes cross node 1.
    const g = RoadGraph.fromLayout({
      nodes: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 4, y: 0 },
        { id: 2, x: 8, y: 0 },
        { id: 3, x: 4, y: 4 },
      ],
      segments: [
        { from: 0, to: 1 },
        { from: 1, to: 2 },
        { from: 1, to: 3 },
      ],
    })
    const s = new TrafficSim(g, { portals: [0, 2, 3], random: rng(5), startingVehicles: 12, spawnIntervalSec: 0.8, junctionClearSec: 2 })
    const crossings: number[] = []
    const onFirstEdge = new Map<number, number>()
    for (let i = 0; i < 1200; i++) {
      s.step(DT)
      for (const v of s.vehicles()) {
        const prev = onFirstEdge.get(v.id)
        if (prev === 0 && v.stepIndex === 1) crossings.push(s.stats().time)
        onFirstEdge.set(v.id, v.stepIndex)
      }
    }
    expect(crossings.length).toBeGreaterThan(10)
    for (let i = 1; i < crossings.length; i++) expect(crossings[i]! - crossings[i - 1]!).toBeGreaterThanOrEqual(2 - 1e-6)
  })

  it('does not limit bends (degree-2 nodes)', () => {
    const s = new TrafficSim(corridor(), { portals: [0, 2], random: { next: () => 0 }, startingVehicles: 3, spawnIntervalSec: 1000, junctionClearSec: 100 })
    run(s, 200)
    expect(s.stats().totalExited).toBe(3)
  })
})

describe('routing changes', () => {
  it('drops spawns explicitly when portals are disconnected', () => {
    const g = corridor()
    g.addNode({ x: 20, y: 20 }, 9)
    const s = sim(g, { portals: [0, 9], startingVehicles: 3 })
    const report = s.step(DT)
    expect(report.unroutable).toBe(3)
    expect(s.stats()).toMatchObject({ active: 0, pendingSpawns: 0, totalUnroutable: 3 })
  })

  it('marks a vehicle stuck when its route is cut, and resumes when reopened', () => {
    const g = corridor()
    const s = new TrafficSim(g, { portals: [0, 2], random: { next: () => 0 }, startingVehicles: 1, spawnIntervalSec: 1000 })
    s.step(DT)
    g.setBlocked(1, true)
    run(s, 60)
    const v = s.vehicles()[0]!
    expect(v.state).toBe('stuck')
    expect(v.stepIndex).toBe(0)
    expect(v.progress).toBeCloseTo(4) // waits at the junction, does not reverse or vanish
    g.setBlocked(1, false)
    run(s, 50)
    expect(s.stats().totalExited).toBe(1)
  })

  it('re-routes at the next junction to use a newly built shortcut', () => {
    // U-shaped road 0 → 1 → 2 → 3 → 4 → 5; a shortcut 1 — 4 is added later.
    const g = RoadGraph.fromLayout({
      nodes: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 0, y: 2 },
        { id: 2, x: 0, y: 12 },
        { id: 3, x: 4, y: 12 },
        { id: 4, x: 4, y: 2 },
        { id: 5, x: 4, y: 0 },
      ],
      segments: [
        { from: 0, to: 1 },
        { from: 1, to: 2 },
        { from: 2, to: 3 },
        { from: 3, to: 4 },
        { from: 4, to: 5 },
      ],
    })
    const s = new TrafficSim(g, { portals: [0, 5], random: { next: () => 0 }, startingVehicles: 1, spawnIntervalSec: 1000 })
    s.step(DT)
    const id = s.vehicles()[0]!.id
    expect(s.getVehicle(id)!.steps.length).toBe(5)
    g.connect({ kind: 'node', node: 1 }, { kind: 'node', node: 4 })
    run(s, 30)
    expect(s.getVehicle(id)!.steps.map((x) => x.to)).toEqual([1, 4, 5])
    // 2 + 4 + 2 tiles at speed 2 ≈ 4 s; the original 28-tile route needs 14 s.
    run(s, 55)
    expect(s.stats().totalExited).toBe(1)
  })

  it('migrates vehicles on a split edge without moving them', () => {
    const g = corridor()
    const s = new TrafficSim(g, { portals: [0, 2], random: { next: () => 0 }, startingVehicles: 1, spawnIntervalSec: 1000 })
    run(s, 30) // 1.5 s at speed 2: 2.9 tiles along edge 0
    const before = s.positionOf(s.vehicles()[0]!).position
    const { split } = g.ensureNodeAt({ kind: 'edge', edge: 0, t: 0.25 })
    s.applySplit(split!)
    const v = s.vehicles()[0]!
    expect(s.positionOf(v).position.x).toBeCloseTo(before.x)
    expect(v.steps.map((x) => x.to)).toEqual([split!.node, 1, 2])
    expect(v.stepIndex).toBe(1)
    expect(s.laneOccupants(split!.towardB, split!.node)).toHaveLength(1)
    run(s, 100)
    expect(s.stats().totalExited).toBe(1)
  })
})

describe('junction edge-split migration (#29)', () => {
  it('keeps a moving vehicle in place and routable when its occupied edge becomes a junction', () => {
    const graph = RoadGraph.fromLayout({
      nodes: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 8, y: 0 },
        { id: 2, x: 4, y: -4 },
        { id: 3, x: 4, y: 4 },
      ],
      segments: [{ from: 0, to: 1 }],
    })
    const traffic = sim(graph, { portals: [0, 1], startingVehicles: 1 })
    run(traffic, 20)
    const vehicle = traffic.vehicles()[0]!
    const before = traffic.positionOf(vehicle).position

    const result = graph.connect({ kind: 'node', node: 2 }, { kind: 'node', node: 3 })
    expect(result.splits).toHaveLength(1)
    for (const split of result.splits) traffic.applySplit(split)

    const migrated = traffic.getVehicle(vehicle.id)!
    const after = traffic.positionOf(migrated).position
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(graph.getEdge(migrated.steps[migrated.stepIndex]!.edge)).toBeDefined()
    expect(traffic.laneOccupants(migrated.steps[migrated.stepIndex]!.edge, migrated.steps[migrated.stepIndex]!.from)).toContain(migrated)

    run(traffic, 200)
    expect(traffic.getVehicle(vehicle.id)).toBeUndefined()
    expect(traffic.stats().totalExited).toBe(1)
  })
})

describe('determinism and timing', () => {
  it('produces identical outcomes for the same seed and step sequence', () => {
    const make = (seed: number) => {
      const { graph, portals } = crossroads()
      const s = new TrafficSim(graph, { portals, random: rng(seed), startingVehicles: 8, spawnIntervalSec: 1 })
      run(s, 600)
      return { stats: s.stats(), vehicles: snapshot(s) }
    }
    expect(make(42)).toEqual(make(42))
    expect(make(42)).not.toEqual(make(43))
  })

  it('is independent of render frame rate', () => {
    const play = (fps: number) => {
      const { graph, portals } = crossroads()
      const s = new TrafficSim(graph, { portals, random: rng(7), startingVehicles: 8, spawnIntervalSec: 1 })
      const clock = new FixedStepClock(20)
      for (let frame = 0; frame < fps * 10; frame++) {
        for (let n = clock.advance(1 / fps); n > 0; n--) s.step(clock.stepSec)
      }
      return { ticks: s.stats().ticks, vehicles: snapshot(s) }
    }
    const at60 = play(60)
    expect(at60.ticks).toBe(200)
    expect(play(30)).toEqual(at60)
    expect(play(144)).toEqual(at60)
  })

  it('stays fast at the 100-vehicle target', () => {
    const { graph, portals } = crossroads()
    const s = sim(graph, { portals, startingVehicles: 100, maxVehicles: 100, spawnIntervalSec: 0.8 })
    const start = performance.now()
    run(s, 20 * 60) // one simulated minute
    expect(performance.now() - start).toBeLessThan(1000)
  })
})

describe('FixedStepClock', () => {
  it('converts elapsed time to whole steps and caps backlog', () => {
    const clock = new FixedStepClock(20, 5)
    expect(clock.advance(0.01)).toBe(0)
    expect(clock.advance(0.04)).toBe(1)
    expect(clock.alpha).toBeCloseTo(0)
    expect(clock.advance(10)).toBe(5)
    expect(clock.alpha).toBe(0)
    expect(clock.advance(-1)).toBe(0)
  })
})
