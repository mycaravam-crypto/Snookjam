import { describe, expect, it } from 'vitest'
import { ConstructionController, createRng, createRoadGraph, TrafficSim, type Point } from '@game/index'
import { asciiWorld } from './fixtures'

/*
 * A crossroads with a tunnel at the end of each arm. Every trip crosses the
 * single central intersection, which lets one vehicle through at a time, so
 * under steady spawning it is a bottleneck and tunnels back up.
 *
 * The west and north arms could be joined directly, but a pond sits in the
 * way of a straight road between them: relief needs a freehand road drawn
 * around it.
 */
const CROSSROADS = [
  '...............',
  '.......#.......',
  '.......#.......',
  '.......#.......',
  '.......#.......',
  '.....~~#.......',
  '.....~~#.......',
  '.#############.',
  '.......#.......',
  '.......#.......',
  '.......#.......',
  '.......#.......',
  '.......#.......',
  '.......#.......',
  '...............',
]

/** Drawn loosely: starts and ends up to ~0.4 tiles off the roads. */
const START: Point = { x: 3.5, y: 7.9 }
const TRACE: Point[] = [
  { x: 3.5, y: 7.1 },
  { x: 3.6, y: 6.5 },
  { x: 3.8, y: 5.3 },
  { x: 4.2, y: 4.4 },
  { x: 5.0, y: 3.9 },
  { x: 6.2, y: 3.6 },
  { x: 7.0, y: 3.5 },
]
const END: Point = { x: 7.9, y: 3.4 }

const DT = 1 / 20

function scenario(seed: number) {
  const world = asciiWorld(CROSSROADS)
  const graph = createRoadGraph(world)
  const portals = graph.nodes().filter((n) => graph.edgesAt(n.id).length === 1).map((n) => n.id)
  const sim = new TrafficSim(graph, {
    portals,
    random: createRng(seed),
    startingVehicles: 8,
    // Steady pressure the single intersection cannot keep up with. (With
    // two-lane junction boxes, #22, 0.4 s saturated even the relieved network,
    // which hid the relief behind tunnel backlog.)
    spawnIntervalSec: 0.6,
    minSpawnIntervalSec: 0.6,
  })
  const controller = new ConstructionController(world, graph, undefined, (from, to, via) => {
    const result = graph.connect(from, to, {}, via)
    for (const split of result.splits) sim.applySplit(split)
    return result
  })
  return { world, graph, sim, controller, portals }
}

/** Runs `seconds` of simulation; returns the mean number of queued/waiting vehicles. */
function run(sim: TrafficSim, seconds: number): number {
  let backlog = 0
  const ticks = Math.round(seconds / DT)
  for (let i = 0; i < ticks; i++) {
    sim.step(DT)
    const s = sim.stats()
    backlog += s.waiting + s.pendingSpawns
  }
  return backlog / ticks
}

function play(seed: number, build: boolean) {
  const s = scenario(seed)
  run(s.sim, 10)
  let outcome
  let jump = 0
  if (build) {
    const before = new Map(s.sim.vehicles().map((v) => [v.id, s.sim.positionOf(v).position]))
    s.controller.pointerDown(START)
    for (const p of TRACE) s.controller.pointerMove(p)
    outcome = s.controller.pointerUp(END)
    for (const v of s.sim.vehicles()) {
      const p = s.sim.positionOf(v).position
      const q = before.get(v.id)!
      jump = Math.max(jump, Math.hypot(p.x - q.x, p.y - q.y))
    }
  }
  const exitedBefore = s.sim.stats().totalExited
  const backlog = run(s.sim, 120)
  return { ...s, outcome, jump, backlog, exited: s.sim.stats().totalExited - exitedBefore }
}

describe('freehand road relieves a bottleneck', () => {
  it('the crossroads is a bottleneck without player roads', () => {
    const base = play(1, false)
    expect(base.portals).toHaveLength(4)
    expect(base.sim.stats().pendingSpawns).toBeGreaterThan(50)
  })

  it('a straight road cannot bypass it (the pond is in the way)', () => {
    const { controller, graph } = scenario(1)
    const version = graph.version
    controller.pointerDown(START)
    expect(controller.pointerUp(END)).toMatchObject({ kind: 'rejected', reason: 'obstacle' })
    expect(graph.version).toBe(version)
  })

  it.each([1, 2, 3])('a snapped freehand bypass increases throughput (seed %i)', (seed) => {
    const base = play(seed, false)
    const built = play(seed, true)
    expect(built.outcome?.kind).toBe('committed')
    if (built.outcome?.kind !== 'committed') return
    // Endpoints snapped onto the west and north arms, mid-segment.
    expect(built.outcome.road.from).toEqual({ x: 3.5, y: 7.5 })
    expect(built.outcome.road.to).toEqual({ x: 7.5, y: 3.4 })
    expect(built.outcome.result.splits).toHaveLength(2)
    expect(built.outcome.road.points.length).toBeGreaterThan(2)

    expect(built.exited).toBeGreaterThan(base.exited * 1.1)
    expect(built.backlog).toBeLessThan(base.backlog * 0.85)
    // Nobody teleported when the road was committed, or got stranded later.
    expect(built.jump).toBeLessThan(1e-9)
    expect(built.sim.stats().stuck).toBe(0)
    for (const v of built.sim.vehicles()) {
      expect(built.graph.nearestLocation(built.sim.positionOf(v).position, 1e-6)).toBeDefined()
    }
  })

  it('is deterministic', () => {
    const a = play(2, true)
    const b = play(2, true)
    expect(b.sim.stats()).toEqual(a.sim.stats())
    expect(b.backlog).toBe(a.backlog)
  })
})
