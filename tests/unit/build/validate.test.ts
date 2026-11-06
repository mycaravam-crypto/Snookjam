import { describe, expect, it } from 'vitest'
import { checkConnection, constructionOptions, checkTerrain, createRoadGraph, findRoute, segmentsIntersect } from '@game/index'
import { asciiWorld, BOTTOM_LEFT, LOOP, TOP_LEFT } from './fixtures'

function setup() {
  const world = asciiWorld(LOOP)
  return { world, graph: createRoadGraph(world) }
}

describe('checkConnection', () => {
  it('accepts a road between two existing roads over passable terrain', () => {
    const { world, graph } = setup()
    const check = checkConnection(world, graph, { x: 2.5, y: 1.5 }, { x: 2.5, y: 5.5 })
    expect(check.ok).toBe(true)
  })

  it('uses a forgiving two-tile radius for the release end while keeping start acquisition precise', () => {
    const { world, graph } = setup()
    const check = checkConnection(world, graph, { x: 2.5, y: 1.5 }, { x: 8, y: 3.5 })
    expect(check.ok).toBe(true)
    if (check.ok) expect(check.to.position.x).toBeCloseTo(9.5)
    expect(checkConnection(world, graph, { x: 2.5, y: 1.5 }, { x: 7.8, y: 3.5 }, constructionOptions({ endSnapDistance: 1.4 }))).toMatchObject({ ok: false, reason: 'not-connected' })
    expect(checkConnection(world, graph, { x: 4.5, y: 3 }, { x: 7.5, y: 5.5 })).toMatchObject({ ok: false, reason: 'not-on-road' })
  })

  it('snaps endpoints near a road onto the road', () => {
    const { world, graph } = setup()
    const check = checkConnection(world, graph, { x: 2.6, y: 1.9 }, { x: 2.4, y: 5.2 })
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.from.position.y).toBeCloseTo(1.5)
    expect(check.to.position.y).toBeCloseTo(5.5)
  })

  it('snaps to a node when close to one', () => {
    const { world, graph } = setup()
    const check = checkConnection(world, graph, { x: 1.7, y: 1.6 }, { x: 1.6, y: 5.4 })
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.from.location).toEqual({ kind: 'node', node: TOP_LEFT })
    expect(check.to.location).toEqual({ kind: 'node', node: BOTTOM_LEFT })
  })

  it('rejects a start that is not on a road', () => {
    const { world, graph } = setup()
    expect(checkConnection(world, graph, { x: 2.5, y: 3.2 }, { x: 2.5, y: 5.5 })).toMatchObject({
      ok: false,
      reason: 'not-on-road',
    })
  })

  it('rejects an end that is not on a road but reports the snapped start', () => {
    const { world, graph } = setup()
    const check = checkConnection(world, graph, { x: 2.5, y: 1.5 }, { x: 2.5, y: 3.2 }, constructionOptions({ endSnapDistance: 1.25 }))
    expect(check).toMatchObject({ ok: false, reason: 'not-connected' })
    expect(check.from).toBeDefined()
  })

  it('rejects zero-length and too-short roads', () => {
    const { world, graph } = setup()
    expect(checkConnection(world, graph, { x: 2.5, y: 1.5 }, { x: 2.5, y: 1.5 })).toMatchObject({ reason: 'too-short' })
    expect(checkConnection(world, graph, { x: 2.5, y: 1.5 }, { x: 3.1, y: 1.5 })).toMatchObject({ reason: 'too-short' })
  })

  it('rejects a road along an existing road', () => {
    const { world, graph } = setup()
    expect(checkConnection(world, graph, { x: 2.5, y: 1.5 }, { x: 7.5, y: 1.5 })).toMatchObject({ reason: 'duplicate' })
  })

  it('rejects a road across water', () => {
    const { world, graph } = setup()
    expect(checkConnection(world, graph, { x: 5.5, y: 1.5 }, { x: 5.5, y: 5.5 })).toMatchObject({ reason: 'obstacle' })
  })

  it('rejects a road that clips water with its width even if the centre line misses', () => {
    const { world, graph } = setup()
    // Centre line at x = 4.9 is grass; the road edge at x = 5.1 is in the pond.
    expect(checkConnection(world, graph, { x: 4.9, y: 1.5 }, { x: 4.9, y: 5.5 })).toMatchObject({ reason: 'obstacle' })
  })

  it('allows a road to cross another road and creates a connected junction', () => {
    const { world, graph } = setup()
    const first = checkConnection(world, graph, { x: 3.5, y: 1.5 }, { x: 3.5, y: 5.5 })
    expect(first.ok).toBe(true)
    if (first.ok) graph.connect(first.from.location, first.to.location)
    const crossing = checkConnection(world, graph, { x: 2.5, y: 1.5 }, { x: 4.5, y: 5.5 })
    expect(crossing.ok).toBe(true)
    if (!crossing.ok) return
    const result = graph.connect(crossing.from.location, crossing.to.location)
    expect(result.splits.length).toBeGreaterThan(0)
    for (const node of result.nodes.slice(1, -1)) expect(graph.edgesAt(node)).toHaveLength(4)
  })

  it('rejects a road longer than the configured maximum', () => {
    const { world, graph } = setup()
    const options = constructionOptions({ maxLength: 3 })
    expect(checkConnection(world, graph, { x: 2.5, y: 1.5 }, { x: 2.5, y: 5.5 }, options)).toMatchObject({
      reason: 'too-long',
    })
  })

  it('allows a road that meets another at a very sharp angle', () => {
    const { world, graph } = setup()
    // Leaves the bottom road's end at about 53 degrees to it.
    expect(checkConnection(world, graph, { x: 1.5, y: 5.5 }, { x: 4.5, y: 1.5 }).ok).toBe(true)
  })

  it('can still enforce a minimum join angle when configured (#22)', () => {
    const { world, graph } = setup()
    const options = constructionOptions({ minJoinAngle: Math.PI / 3 })
    expect(checkConnection(world, graph, { x: 1.5, y: 5.5 }, { x: 4.5, y: 1.5 }, options)).toMatchObject({ reason: 'too-sharp' })
  })

  it('rejects a road that runs too close to another road (#22)', () => {
    const { world, graph } = setup()
    const first = checkConnection(world, graph, { x: 2.5, y: 1.5 }, { x: 2.5, y: 5.5 })
    expect(first.ok).toBe(true)
    if (first.ok) graph.connect(first.from.location, first.to.location)
    // Parallel to the new road, half a tile away: the two-lane surfaces would overlap.
    expect(checkConnection(world, graph, { x: 3.1, y: 1.5 }, { x: 3.1, y: 5.5 })).toMatchObject({ reason: 'too-close' })
    // A road-width and a bit away is fine.
    expect(checkConnection(world, graph, { x: 3.9, y: 1.5 }, { x: 3.9, y: 5.5 }).ok).toBe(true)
  })

  it('does not mutate the graph', () => {
    const { world, graph } = setup()
    const version = graph.version
    checkConnection(world, graph, { x: 2.5, y: 1.5 }, { x: 2.5, y: 5.5 })
    checkConnection(world, graph, { x: 5.5, y: 1.5 }, { x: 5.5, y: 5.5 })
    expect(graph.version).toBe(version)
  })

  it('a committed connection makes routes shorter', () => {
    const { world, graph } = setup()
    const before = findRoute(graph, TOP_LEFT, BOTTOM_LEFT)
    expect(before.ok).toBe(true)
    const check = checkConnection(world, graph, { x: 1.5, y: 1.5 }, { x: 1.5, y: 5.5 })
    expect(check.ok).toBe(true)
    if (!check.ok || !before.ok) return
    graph.connect(check.from.location, check.to.location)
    const after = findRoute(graph, TOP_LEFT, BOTTOM_LEFT)
    expect(after.ok).toBe(true)
    if (after.ok) expect(after.route.cost).toBeLessThan(before.route.cost)
  })
})

describe('checkTerrain', () => {
  it('flags points off the map', () => {
    const { world } = setup()
    expect(checkTerrain(world, { x: 1.5, y: 1.5 }, { x: -1, y: 1.5 }, 0.2)).toBe('off-map')
    expect(checkTerrain(world, { x: 1.5, y: 1.5 }, { x: 3.5, y: 1.5 }, 0.2)).toBeUndefined()
  })
})

describe('segmentsIntersect', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 4, y: 0 }
  it('detects proper crossings', () => {
    expect(segmentsIntersect(a, b, { x: 2, y: -1 }, { x: 2, y: 1 })).toBe(true)
  })
  it('ignores touching at its own endpoints', () => {
    expect(segmentsIntersect(a, b, { x: 4, y: -1 }, { x: 4, y: 1 })).toBe(false)
    expect(segmentsIntersect(a, b, { x: 0, y: 0 }, { x: 0, y: 3 })).toBe(false)
  })
  it('detects passing through another road’s endpoint', () => {
    expect(segmentsIntersect(a, b, { x: 2, y: 0 }, { x: 2, y: 3 })).toBe(true)
  })
  it('handles parallel and collinear segments', () => {
    expect(segmentsIntersect(a, b, { x: 0, y: 1 }, { x: 4, y: 1 })).toBe(false)
    expect(segmentsIntersect(a, b, { x: 3, y: 0 }, { x: 6, y: 0 })).toBe(true)
    expect(segmentsIntersect(a, b, { x: 5, y: 0 }, { x: 6, y: 0 })).toBe(false)
  })
})
