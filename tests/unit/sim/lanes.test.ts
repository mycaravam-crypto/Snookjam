import { describe, expect, it } from 'vitest'
import {
  checkConnection,
  GameSession,
  junctionStopDistance,
  laneOffset,
  minFollowingDistance,
  ROAD_GEOMETRY,
  RoadGraph,
  roadWidth,
  TrafficSim,
  validateRoadGeometry,
  type Vehicle,
} from '@game/index'
import { collisions } from './footprint'

const DT = 0.05
const random = { next: () => 0.37 }

function step(sim: TrafficSim, n: number, each?: () => void): void {
  for (let i = 0; i < n; i++) {
    sim.step(DT)
    each?.()
  }
}

describe('two-lane road geometry', () => {
  it('fits two lanes, with a safety gap between passing vehicles', () => {
    const g = ROAD_GEOMETRY
    expect(roadWidth(g)).toBeCloseTo(2 * g.laneWidth)
    expect(laneOffset(g)).toBeCloseTo(g.laneWidth / 2)
    // Opposing vehicle centres are 2 × laneOffset apart.
    expect(2 * laneOffset(g) - g.vehicleWidth).toBeGreaterThanOrEqual(g.safetyGap)
    // Each vehicle stays within the road surface.
    expect(laneOffset(g) + g.vehicleWidth / 2).toBeLessThanOrEqual(roadWidth(g) / 2)
    expect(junctionStopDistance(g)).toBeGreaterThan(roadWidth(g) / 2 + g.vehicleLength / 2)
  })

  it('rejects geometry that would let vehicles touch', () => {
    expect(() => validateRoadGeometry({ ...ROAD_GEOMETRY, laneWidth: 0.2 }, 2)).toThrow(RangeError)
    expect(() => validateRoadGeometry(ROAD_GEOMETRY, 0.6)).toThrow(RangeError)
    expect(() => validateRoadGeometry({ ...ROAD_GEOMETRY, cornerRadius: 0.1 }, 2)).toThrow(RangeError)
    expect(() => validateRoadGeometry(ROAD_GEOMETRY, minFollowingDistance())).not.toThrow()
  })

  it('uses the geometry for the default following distance', () => {
    const g = RoadGraph.fromLayout({ nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 5, y: 0 }], segments: [{ from: 0, to: 1 }] })
    const sim = new TrafficSim(g, { portals: [0, 1], random })
    expect(sim.minGap).toBeGreaterThanOrEqual(minFollowingDistance())
    expect(() => new TrafficSim(g, { portals: [0, 1], random, minGap: 0.6 })).toThrow(RangeError)
  })
})

describe('opposing traffic on a straight road', () => {
  it('passes in separate lanes without overlapping', () => {
    const g = RoadGraph.fromLayout({ nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 10, y: 0 }], segments: [{ from: 0, to: 1 }] })
    const sim = new TrafficSim(g, { portals: [0, 1], random: { next: () => 0 }, startingVehicles: 0, spawnIntervalSec: 1000 })
    sim.queueSpawns(1) // from portal 0, eastbound
    step(sim, 1)
    const east = sim.vehicles()[0]!
    // Second vehicle from portal 1, westbound (portal 0's lane is busy... pick explicitly).
    const sim2Random = { values: [0.99, 0], next() { return this.values.shift() ?? 0 } }
    ;(sim as unknown as { random: typeof sim2Random }).random = sim2Random
    sim.queueSpawns(1)
    step(sim, 1)
    const west = sim.vehicles().find((v) => v.id !== east.id)!
    expect(west.steps[0]!.from).toBe(1)

    let passed = false
    step(sim, 200, () => {
      expect(collisions(sim)).toEqual([])
      const a = sim.getVehicle(east.id)
      const b = sim.getVehicle(west.id)
      if (!a || !b) return
      const pa = sim.lanePositionOf(a).position
      const pb = sim.lanePositionOf(b).position
      // Right-hand traffic: eastbound below the centre line, westbound above.
      expect(pa.y).toBeCloseTo(laneOffset())
      expect(pb.y).toBeCloseTo(-laneOffset())
      if (Math.abs(pa.x - pb.x) < ROAD_GEOMETRY.vehicleLength) passed = true
    })
    expect(passed).toBe(true) // they were side by side at some point
  })
})

describe('following within a lane', () => {
  it('keeps minGap along the route, including across a bend', () => {
    // L-shaped road: east then south, with a bend node at (4, 0).
    const g = RoadGraph.fromLayout({
      nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 4, y: 0 }, { id: 2, x: 4, y: 4 }],
      segments: [{ from: 0, to: 1 }, { from: 1, to: 2, speedLimit: 0.3 }],
    })
    const sim = new TrafficSim(g, { portals: [0, 2], random: { next: () => 0 }, startingVehicles: 6, spawnIntervalSec: 1000 })
    const routeDistance = (v: Vehicle) => (v.stepIndex === 0 ? v.progress : 4 + v.progress) * (v.steps[0]!.from === 0 ? 1 : -1)
    step(sim, 300, () => {
      expect(collisions(sim)).toEqual([])
      const eastbound = sim.vehicles().filter((v) => v.steps[0]!.from === 0).map(routeDistance).sort((a, b) => b - a)
      for (let i = 1; i < eastbound.length; i++) {
        expect(eastbound[i - 1]! - eastbound[i]!).toBeGreaterThanOrEqual(sim.minGap - 1e-6)
      }
    })
  })
})

describe('curved roads', () => {
  it('moves vehicles continuously through bends, staying in lane', () => {
    // A zig-zag with several bends, traffic both ways.
    const g = RoadGraph.fromLayout({
      nodes: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 3, y: 0 },
        { id: 2, x: 3, y: 3 },
        { id: 3, x: 6, y: 3 },
        { id: 4, x: 7, y: 5 },
        { id: 5, x: 10, y: 5 },
      ],
      segments: [{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 4 }, { from: 4, to: 5 }],
    })
    let n = 0
    const sim = new TrafficSim(g, { portals: [0, 5], random: { next: () => (n++ % 3) / 3 }, startingVehicles: 4, spawnIntervalSec: 1.5 })
    const last = new Map<number, { x: number; y: number; h: number }>()
    const maxStep = 2 * DT * 1.6 // speed limit 2 tiles/s, with slack for the curve parameterisation
    step(sim, 600, () => {
      expect(collisions(sim)).toEqual([])
      for (const v of sim.vehicles()) {
        const { position, heading } = sim.lanePositionOf(v)
        const prev = last.get(v.id)
        if (prev) {
          expect(Math.hypot(position.x - prev.x, position.y - prev.y)).toBeLessThanOrEqual(maxStep)
          const dh = Math.abs(Math.atan2(Math.sin(heading - prev.h), Math.cos(heading - prev.h)))
          expect(dh).toBeLessThan(0.6) // no sudden turns or lane swaps
        }
        last.set(v.id, { x: position.x, y: position.y, h: heading })
      }
    })
    expect(sim.stats().totalExited).toBeGreaterThan(5)
  })
})

describe('junctions', () => {
  // A crossroads at node 1 with four portals; every route crosses node 1.
  const crossroads = () =>
    RoadGraph.fromLayout({
      nodes: [
        { id: 0, x: 0, y: 5 },
        { id: 1, x: 5, y: 5 },
        { id: 2, x: 10, y: 5 },
        { id: 3, x: 5, y: 0 },
        { id: 4, x: 5, y: 10 },
      ],
      segments: [{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 3, to: 1 }, { from: 1, to: 4 }],
    })

  it('holds one vehicle at a time in the box and stops the rest at the stop line', () => {
    const g = crossroads()
    let n = 0
    const sim = new TrafficSim(g, { portals: [0, 2, 3, 4], random: { next: () => ((n++ * 7) % 11) / 11 }, startingVehicles: 12, spawnIntervalSec: 0.8, junctionClearSec: 0.5 })
    let sawQueue = false
    step(sim, 1200, () => {
      expect(collisions(sim)).toEqual([])
      const holder = sim.junctionHolderAt(1)
      for (const v of sim.vehicles()) {
        const s = v.steps[v.stepIndex]!
        if (s.to !== 1 || v.id === holder) continue
        // Not holding the box: must not pass the stop line.
        expect(v.progress).toBeLessThanOrEqual(5 - sim.stopDistance + 1e-6)
        if (v.state === 'waiting') sawQueue = true
      }
    })
    expect(sawQueue).toBe(true)
    expect(sim.stats().totalExited).toBeGreaterThan(20)
  })

  it('treats intersections a short road apart as one box, so they cannot deadlock', () => {
    // Two T-junctions 1 tile apart (nodes 1 and 2), with portals all around.
    const g = RoadGraph.fromLayout({
      nodes: [
        { id: 0, x: 0, y: 3 },
        { id: 1, x: 5, y: 3 },
        { id: 2, x: 6, y: 3 },
        { id: 3, x: 11, y: 3 },
        { id: 4, x: 5, y: 8 },
        { id: 5, x: 6, y: 0 },
      ],
      segments: [{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 }, { from: 1, to: 4 }, { from: 2, to: 5 }],
    })
    let n = 0
    const sim = new TrafficSim(g, { portals: [0, 3, 4, 5], random: { next: () => ((n++ * 5) % 13) / 13 }, startingVehicles: 16, spawnIntervalSec: 0.8, junctionClearSec: 0.3 })
    let exitedAt60s = 0
    step(sim, 2400, () => {
      expect(collisions(sim)).toEqual([])
      if (sim.stats().ticks === 1200) exitedAt60s = sim.stats().totalExited
      // Both junctions belong to the same box.
      expect(sim.junctionHolderAt(1)).toBe(sim.junctionHolderAt(2))
    })
    // Traffic keeps flowing in the second minute (no gridlock).
    expect(sim.stats().totalExited).toBeGreaterThan(exitedAt60s + 10)
    for (const v of sim.vehicles()) expect(v.waitingFor).toBeLessThan(30)
  })
})

/** Seeds 15, 18 and 20 caught vehicles stranded in a box by a new road (#32). */
const REGRESSION_SEEDS = [15, 18, 20]

describe('generated traffic with player-built junctions', () => {
  it.each(REGRESSION_SEEDS)('keeps vehicles collision-free through a full level (seed %i)', (seed) => {
    const session = new GameSession({ seed })
    session.start()
    let builtAny = false
    let builtSharp = 0

    for (let t = 0; t < 20 * 180 && session.state === 'running'; t++) {
      session.tick()

      // Exercise both ordinary and sharp-angle player roads in the same run.
      if (t === 20 * 30 || t === 20 * 90) builtSharp += buildSharpRoad(session) ? 1 : 0
      if (t === 20 * 60) builtAny = buildAnyRoad(session)

      if (t % 2 === 0) expect(collisions(session.sim)).toEqual([])
    }

    expect(builtAny).toBe(true)
    expect(builtSharp).toBeGreaterThan(0)
  })
})

/** Commits a valid straight road leaving a node at under 45 degrees to one of its roads. */
function buildSharpRoad(session: GameSession): boolean {
  const g = session.graph
  for (const a of g.nodes()) {
    for (const b of g.nodes()) {
      const dx = b.position.x - a.position.x
      const dy = b.position.y - a.position.y
      const len = Math.hypot(dx, dy)
      if (len < 2 || len > 7) continue
      const sharp = g.edgesAt(a.id).some((e) => {
        const q = g.getNode(g.otherEnd(e, a.id))!.position
        const ex = q.x - a.position.x
        const ey = q.y - a.position.y
        return (dx * ex + dy * ey) / (len * Math.hypot(ex, ey)) > Math.cos(Math.PI / 4)
      })
      if (!sharp) continue
      const check = checkConnection(session.world, session.graph, a.position, b.position)
      if (check.ok) {
        session.connectRoad(check.from.location, check.to.location)
        return true
      }
    }
  }
  return false
}

/** Commits the first valid straight road between two graph nodes. */
function buildAnyRoad(session: GameSession): boolean {
  const nodes = session.graph.nodes()
  for (const a of nodes) {
    for (const b of nodes) {
      const len = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y)
      if (len < 3 || len > 6) continue
      const check = checkConnection(session.world, session.graph, a.position, b.position)
      if (check.ok) {
        session.connectRoad(check.from.location, check.to.location)
        return true
      }
    }
  }
  return false
}
