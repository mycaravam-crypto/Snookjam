import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RoadGraph, findRoute, isRouteValid, type Route } from '../../../src/game/roads'

function expectContinuous(route: Route): void {
  expect(route.nodes[0]).toBe(route.origin)
  expect(route.nodes.at(-1)).toBe(route.destination)
  route.steps.forEach((step, i) => {
    expect(step.from).toBe(route.nodes[i])
    expect(step.to).toBe(route.nodes[i + 1])
  })
}

/**
 *   0 ——— 1 ——— 2        top road: two 4-tile edges, slow (speed 1)
 *   |           |
 *   3 —————————— 4       bottom road: fast (speed 4), with 2-tile spurs
 */
function diamond(): RoadGraph {
  return RoadGraph.fromLayout({
    nodes: [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 4, y: 0 },
      { id: 2, x: 8, y: 0 },
      { id: 3, x: 0, y: 2 },
      { id: 4, x: 8, y: 2 },
    ],
    segments: [
      { from: 0, to: 1, speedLimit: 1 },
      { from: 1, to: 2, speedLimit: 1 },
      { from: 0, to: 3, speedLimit: 2 },
      { from: 3, to: 4, speedLimit: 4 },
      { from: 4, to: 2, speedLimit: 2 },
    ],
  })
}

describe('findRoute', () => {
  it('returns an empty route when origin is the destination', () => {
    const result = findRoute(diamond(), 1, 1)
    expect(result).toMatchObject({ ok: true, route: { steps: [], nodes: [1], cost: 0 } })
  })

  it('finds a direct single-edge route', () => {
    const result = findRoute(diamond(), 0, 1)
    if (!result.ok) throw new Error(result.reason)
    expect(result.route.nodes).toEqual([0, 1])
    expect(result.route.cost).toBe(4)
  })

  it('picks the faster alternative over the shorter one', () => {
    const result = findRoute(diamond(), 0, 2)
    if (!result.ok) throw new Error(result.reason)
    // Top: 8 tiles at speed 1 = 8s. Bottom: 1 + 2 + 1 = 4s.
    expect(result.route.nodes).toEqual([0, 3, 4, 2])
    expect(result.route.cost).toBe(4)
    expectContinuous(result.route)
  })

  it('routes in both directions over two-way edges', () => {
    const result = findRoute(diamond(), 2, 0)
    if (!result.ok) throw new Error(result.reason)
    expect(result.route.nodes).toEqual([2, 4, 3, 0])
  })

  it('returns explicit no-route results', () => {
    const g = diamond()
    g.addNode({ x: 20, y: 20 }, 9)
    expect(findRoute(g, 0, 9)).toEqual({ ok: false, reason: 'unreachable' })
    expect(findRoute(g, 99, 0)).toEqual({ ok: false, reason: 'unknown-origin' })
    expect(findRoute(g, 0, 99)).toEqual({ ok: false, reason: 'unknown-destination' })
  })

  it('avoids blocked edges and reports unreachable when cut off', () => {
    const g = diamond()
    g.setBlocked(g.edgeBetween(3, 4)!.id, true)
    const detour = findRoute(g, 0, 2)
    expect(detour.ok && detour.route.nodes).toEqual([0, 1, 2])
    g.setBlocked(g.edgeBetween(1, 2)!.id, true)
    expect(findRoute(g, 0, 2)).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('supports custom cost functions', () => {
    const g = diamond()
    const byLength = findRoute(g, 0, 2, { cost: (e) => e.length })
    expect(byLength.ok && byLength.route.nodes).toEqual([0, 1, 2])
  })

  it('uses a newly added connection in subsequent queries', () => {
    // Long U-shaped road; a player shortcut across the gap should be taken.
    const g = RoadGraph.fromLayout({
      nodes: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 0, y: 10 },
        { id: 2, x: 4, y: 10 },
        { id: 3, x: 4, y: 0 },
      ],
      segments: [
        { from: 0, to: 1 },
        { from: 1, to: 2 },
        { from: 2, to: 3 },
      ],
    })
    const before = findRoute(g, 0, 3)
    if (!before.ok) throw new Error(before.reason)
    expect(before.route.cost).toBe(12)

    g.connect({ kind: 'edge', edge: 0, t: 0.1 }, { kind: 'edge', edge: 2, t: 0.9 })
    const after = findRoute(g, 0, 3)
    if (!after.ok) throw new Error(after.reason)
    expect(after.route.cost).toBe(3) // 1 + 4 + 1 tiles at speed 2
    expectContinuous(after.route)
    expect(isRouteValid(g, before.route)).toBe(false) // edge 0 was split
    expect(isRouteValid(g, after.route)).toBe(true)
  })

  it('is deterministic with equal-cost alternatives', () => {
    const square = () =>
      RoadGraph.fromLayout({
        nodes: [
          { id: 0, x: 0, y: 0 },
          { id: 1, x: 2, y: 0 },
          { id: 2, x: 0, y: 2 },
          { id: 3, x: 2, y: 2 },
        ],
        segments: [
          { from: 0, to: 2 },
          { from: 0, to: 1 },
          { from: 1, to: 3 },
          { from: 2, to: 3 },
        ],
      })
    const routes = Array.from({ length: 5 }, () => findRoute(square(), 0, 3))
    const first = routes[0]!
    if (!first.ok) throw new Error(first.reason)
    expect(first.route.nodes).toEqual([0, 1, 3])
    for (const r of routes) expect(r).toEqual(first)
  })

  it('handles a grid-sized graph quickly', () => {
    const w = 40
    const h = 30
    const nodes = []
    const segments = []
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        nodes.push({ id: y * w + x, x, y })
        if (x > 0) segments.push({ from: y * w + x - 1, to: y * w + x })
        if (y > 0) segments.push({ from: (y - 1) * w + x, to: y * w + x })
      }
    const g = RoadGraph.fromLayout({ nodes, segments })
    const start = performance.now()
    const result = findRoute(g, 0, w * h - 1)
    expect(performance.now() - start).toBeLessThan(100)
    expect(result.ok && result.route.steps.length).toBe(w - 1 + h - 1)
  })
})

describe('isRouteValid', () => {
  it('detects removed and blocked edges only from the remaining steps', () => {
    const g = diamond()
    const result = findRoute(g, 0, 2)
    if (!result.ok) throw new Error(result.reason)
    const { route } = result
    expect(isRouteValid(g, route)).toBe(true)
    g.setBlocked(g.edgeBetween(0, 3)!.id, true)
    expect(isRouteValid(g, route)).toBe(false)
    expect(isRouteValid(g, route, 1)).toBe(true) // already past the blocked edge
  })
})

describe('roads module boundaries', () => {
  it('does not import UI or rendering code', () => {
    const dir = join(__dirname, '../../../src/game/roads')
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf8')
      expect(source).not.toMatch(/from\s+['"](vue|@vue\/|@app\/|\.\.\/\.\.\/app)/)
      expect(source).not.toMatch(/CanvasRenderingContext2D|document\.|window\./)
    }
  })
})
