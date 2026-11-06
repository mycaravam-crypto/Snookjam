import { describe, expect, it } from 'vitest'
import {
  checkPath,
  constructionOptions,
  ConstructionController,
  createRoadGraph,
  DEFAULT_SNAP_DISTANCE,
  findRoute,
  pointSegmentDistance,
  type Point,
} from '@game/index'
import { asciiWorld, LOOP } from './fixtures'

/*
 * LOOP: top road y = 1.5 (x 1.5..10.5), right road x = 9.5, bottom road
 * y = 5.5, pond in tiles (5..6, 3).
 */
function setup(options = constructionOptions()) {
  const world = asciiWorld(LOOP)
  const graph = createRoadGraph(world)
  return { world, graph, controller: new ConstructionController(world, graph, options) }
}

/**
 * A curve from the top road down past the pond to the bottom road. Two-lane
 * roads (#22) are 0.76 tiles wide and must keep a road width from roads they
 * do not join, so below the pond the curve runs in the narrow band between
 * the pond (y 4) and the bottom road's clearance (y 4.74).
 */
const CURVE: Point[] = [
  { x: 3.2, y: 2.4 },
  { x: 3.5, y: 3.3 },
  { x: 3.9, y: 4.25 },
  { x: 4.8, y: 4.62 },
  { x: 6.0, y: 4.62 },
  { x: 7.0, y: 4.6 },
  { x: 7.6, y: 4.7 },
]

function draw(controller: ConstructionController, start: Point, trace: Point[], end: Point) {
  controller.pointerDown(start)
  for (const p of trace) controller.pointerMove(p)
  return controller.pointerUp(end)
}

/** Largest distance of a polyline's points from the straight chord between its ends. */
function bulge(points: readonly Point[]): number {
  const a = points[0]!
  const b = points[points.length - 1]!
  return Math.max(...points.map((p) => pointSegmentDistance(p, a, b)))
}

describe('freehand road drawing', () => {
  it('commits a visibly non-straight road that follows the drawn trajectory', () => {
    const { controller, graph } = setup()
    const nodes = graph.nodeCount
    const outcome = draw(controller, { x: 3, y: 1.7 }, CURVE, { x: 7.8, y: 5.3 })
    expect(outcome.kind).toBe('committed')
    if (outcome.kind !== 'committed') return
    const { points } = outcome.road
    expect(points.length).toBeGreaterThan(2)
    expect(bulge(points)).toBeGreaterThan(1)
    // Every bend is close to what the player drew.
    for (const bend of points.slice(1, -1)) {
      const d = Math.min(...CURVE.slice(1).map((q, i) => pointSegmentDistance(bend, CURVE[i]!, q)))
      expect(d).toBeLessThan(0.5)
    }
    // Graph: one node per bend plus the two split junctions, chained by edges.
    expect(outcome.result.edges).toHaveLength(points.length - 1)
    expect(outcome.result.nodes).toHaveLength(points.length)
    expect(graph.nodeCount).toBe(nodes + points.length - 2 + outcome.result.splits.length)
    outcome.result.nodes.forEach((id, i) => {
      expect(graph.getNode(id)!.position.x).toBeCloseTo(points[i]!.x, 9)
      expect(graph.getNode(id)!.position.y).toBeCloseTo(points[i]!.y, 9)
    })
  })

  it('validates an open endpoint without requiring a destination snap', () => {
    const { world, graph } = setup()
    const check = checkPath(world, graph, { x: 2.5, y: 1.5 }, { x: 3.5, y: 3.5 }, [
      { x: 3, y: 2.5 },
    ])
    expect(check.ok).toBe(true)
    if (check.ok) {
      expect(check.to).toBeUndefined()
      expect(check.path.at(-1)).toEqual({ x: 3.5, y: 3.5 })
    }
  })

  it('previews the smoothed trajectory while drawing', () => {
    const { controller } = setup()
    controller.pointerDown({ x: 3, y: 1.7 })
    // Stop short of the bottom road's snap range.
    for (const p of CURVE.slice(0, 2)) controller.pointerMove(p)
    controller.pointerMove({ x: 4.6, y: 3.6 })
    const preview = controller.preview!
    expect(preview.path[0]).toEqual({ x: 3, y: 1.5 })
    expect(preview.path[preview.path.length - 1]).toEqual({ x: 4.6, y: 3.6 })
    expect(preview.path.length).toBeGreaterThan(2)
    expect(preview.check.ok).toBe(true)
    expect(preview.endSnap).toBeUndefined()
  })

  it('accepts coalesced samples in a single move', () => {
    const { controller } = setup()
    controller.pointerDown({ x: 3, y: 1.7 })
    controller.pointerMove(CURVE)
    expect(controller.preview!.path.length).toBeGreaterThan(2)
    expect(controller.pointerUp({ x: 7.8, y: 5.3 }).kind).toBe('committed')
  })

  it('makes the new road available to route queries', () => {
    const { controller, graph } = setup()
    const outcome = draw(controller, { x: 3, y: 1.7 }, CURVE, { x: 7.8, y: 5.3 })
    if (outcome.kind !== 'committed') throw new Error('expected a road')
    const [start, end] = [outcome.result.nodes[0]!, outcome.result.nodes[outcome.result.nodes.length - 1]!]
    const found = findRoute(graph, start, end)
    if (!found.ok) throw new Error('expected a route')
    expect(found.route.steps.map((s) => s.edge)).toEqual(outcome.result.edges)
  })
})

describe('generous snapping', () => {
  it(`uses a forgiving default tolerance of ${DEFAULT_SNAP_DISTANCE} tiles`, () => {
    expect(DEFAULT_SNAP_DISTANCE).toBeGreaterThanOrEqual(1)
    const { controller } = setup()
    // 1.1 tiles off the road still starts a road, snapped onto it.
    expect(controller.pointerDown({ x: 3, y: 2.6 })).toBe(true)
    expect(controller.preview!.from).toEqual({ x: 3, y: 1.5 })
  })

  it('snaps both ends onto road segments, not only to junctions', () => {
    const { controller } = setup()
    const outcome = draw(controller, { x: 3.4, y: 2.4 }, CURVE, { x: 7.8, y: 4.6 })
    expect(outcome.kind).toBe('committed')
    if (outcome.kind !== 'committed') return
    expect(outcome.road.from).toEqual({ x: 3.4, y: 1.5 })
    expect(outcome.road.to).toEqual({ x: 7.8, y: 5.5 })
    // Both ends were mid-edge, so both existing edges were split.
    expect(outcome.result.splits).toHaveLength(2)
  })

  it('snaps to a junction when the end is near one', () => {
    const { world, graph } = setup()
    // The loop's dead end at (1.5, 5.5). (Its inner corners cannot be joined:
    // no direction is 60 degrees from both roads there, #22.)
    const check = checkPath(world, graph, { x: 3, y: 1.6 }, { x: 1.7, y: 5.3 }, [
      { x: 2.9, y: 2.6 },
      { x: 2.5, y: 3.5 },
      { x: 2.0, y: 4.4 },
    ])
    expect(check.ok).toBe(true)
    expect(check.to?.location.kind).toBe('node')
    expect(check.to?.position).toEqual({ x: 1.5, y: 5.5 })
  })

  it('updates the snap continuously while drawing', () => {
    const { controller } = setup()
    controller.pointerDown({ x: 3, y: 1.7 })
    controller.pointerMove(CURVE.slice(0, 2))
    expect(controller.preview!.endSnap).toBeUndefined()
    controller.pointerMove({ x: 7, y: 4.5 })
    expect(controller.preview!.endSnap?.position).toEqual({ x: 7, y: 5.5 })
    expect(controller.preview!.to).toEqual({ x: 7, y: 5.5 })
    expect(controller.preview!.pointer).toEqual({ x: 7, y: 4.5 })
    controller.pointerMove({ x: 7, y: 3.9 })
    expect(controller.preview!.endSnap).toBeUndefined()
  })

  it('does not connect outside the configured tolerance', () => {
    const tight = setup(constructionOptions({ snapDistance: 0.5 }))
    expect(tight.controller.pointerDown({ x: 3, y: 2.6 })).toBe(false)
    const outcome = draw(tight.controller, { x: 3, y: 1.7 }, CURVE, { x: 7.6, y: 4.5 })
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'not-connected' })
    expect(tight.controller.builtRoads).toHaveLength(0)
  })

  it('rejects invalid tolerance settings', () => {
    expect(() => constructionOptions({ snapDistance: 0 })).toThrow(RangeError)
    expect(() => constructionOptions({ minSegmentLength: 0 })).toThrow(RangeError)
  })
})

describe('freehand validation', () => {
  it('rejects a path that crosses water and leaves the graph unchanged', () => {
    const { controller, graph } = setup()
    const before = graph.toLayout()
    const version = graph.version
    const wet = [
      { x: 4, y: 2.5 },
      { x: 5.5, y: 3.5 },
      { x: 7, y: 4.5 },
    ]
    expect(draw(controller, { x: 3, y: 1.6 }, wet, { x: 8, y: 5.4 })).toMatchObject({
      kind: 'rejected',
      reason: 'obstacle',
    })
    expect(graph.version).toBe(version)
    expect(graph.toLayout()).toEqual(before)
  })

  it('rejects a path that crosses another road between its ends', () => {
    const { world, graph } = setup()
    // From the top road, out across the right-hand road and back to the bottom road.
    const trace = [
      { x: 7, y: 2.4 },
      { x: 10.5, y: 3 },
      { x: 10.6, y: 4.3 },
      { x: 8.5, y: 4.6 },
    ]
    expect(checkPath(world, graph, { x: 7, y: 1.6 }, { x: 8, y: 5.4 }, trace)).toMatchObject({
      ok: false,
      reason: 'crosses-road',
    })
  })

  it('rejects a path that loops over itself', () => {
    const { world, graph } = setup()
    const loop = [
      { x: 2.4, y: 2.6 },
      { x: 2.6, y: 3.4 },
      { x: 3.8, y: 4.3 },
      { x: 2.2, y: 4.4 },
      { x: 3.6, y: 2.9 },
      { x: 4.4, y: 2.5 },
    ]
    expect(checkPath(world, graph, { x: 2.2, y: 1.6 }, { x: 5, y: 1.6 }, loop)).toMatchObject({
      ok: false,
      reason: 'self-crossing',
    })
  })

  it('rejects a road drawn hugging an existing one', () => {
    const { world, graph } = setup()
    const hug = [
      { x: 3, y: 1.8 },
      { x: 4.5, y: 1.9 },
      { x: 6, y: 1.9 },
    ]
    const check = checkPath(world, graph, { x: 2, y: 1.6 }, { x: 7.5, y: 1.6 }, hug)
    expect(check.ok).toBe(false)
  })

  it('rejects a zero-length tap', () => {
    const { controller, graph } = setup()
    const version = graph.version
    expect(draw(controller, { x: 3, y: 1.6 }, [], { x: 3.05, y: 1.6 })).toMatchObject({ kind: 'rejected' })
    expect(graph.version).toBe(version)
  })

  it('reports a failed commit as rejected without recording a road', () => {
    const world = asciiWorld(LOOP)
    const graph = createRoadGraph(world)
    const controller = new ConstructionController(world, graph, undefined, () => {
      throw new Error('game over')
    })
    expect(draw(controller, { x: 3, y: 1.7 }, CURVE, { x: 7.8, y: 5.3 })).toMatchObject({
      kind: 'rejected',
      reason: 'build-failed',
    })
    expect(controller.builtRoads).toHaveLength(0)
  })
})
