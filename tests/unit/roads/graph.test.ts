import { describe, expect, it } from 'vitest'
import { RoadGraph, defaultCapacity, type RoadLayout } from '../../../src/game/roads'

/** A — B — C in a straight line along y = 0, 4 tiles apart. */
function line(): RoadGraph {
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

describe('RoadGraph construction', () => {
  it('creates nodes and edges with derived attributes', () => {
    const g = new RoadGraph()
    const a = g.addNode({ x: 0, y: 0 })
    const b = g.addNode({ x: 3, y: 4 })
    const e = g.addEdge(a.id, b.id, { speedLimit: 5 })
    expect(e.length).toBe(5)
    expect(e.speedLimit).toBe(5)
    expect(e.capacity).toBe(defaultCapacity(5))
    expect(g.travelTime(e)).toBe(1)
    expect(g.edgeBetween(b.id, a.id)?.id).toBe(e.id)
    expect(g.otherEnd(e, a.id)).toBe(b.id)
    expect(g.edgesAt(a.id).map((x) => x.id)).toEqual([e.id])
  })

  it('rejects invalid edges', () => {
    const g = line()
    expect(() => g.addEdge(0, 0)).toThrow(/itself/)
    expect(() => g.addEdge(0, 1)).toThrow(/already connected/)
    expect(() => g.addEdge(0, 99)).toThrow(/unknown node/)
    g.addNode({ x: 0, y: 0 }, 10)
    expect(() => g.addEdge(0, 10)).toThrow(/non-zero/)
    expect(() => g.addNode({ x: 1, y: 1 }, 1)).toThrow(/exists/)
  })

  it('round-trips layouts without losing connectivity', () => {
    const layout: RoadLayout = {
      nodes: [
        { id: 5, x: 0, y: 0 },
        { id: 7, x: 2, y: 0 },
        { id: 9, x: 2, y: 2 },
      ],
      segments: [
        { from: 5, to: 7 },
        { from: 7, to: 9, speedLimit: 1, capacity: 3 },
      ],
    }
    const g = RoadGraph.fromLayout(layout)
    const again = RoadGraph.fromLayout(g.toLayout())
    expect(again.nodes().map((n) => n.id)).toEqual([5, 7, 9])
    expect(again.edgeBetween(7, 9)).toMatchObject({ speedLimit: 1, capacity: 3 })
    expect(again.edgeBetween(5, 7)).toBeDefined()
    // New nodes never collide with imported ids.
    expect(again.addNode({ x: 9, y: 9 }).id).toBe(10)
  })

  it('bumps version on every mutation', () => {
    const g = line()
    const v = g.version
    g.setBlocked(0, true)
    expect(g.version).toBe(v + 1)
    g.setBlocked(0, true)
    expect(g.version).toBe(v + 1)
    g.removeEdge(0)
    expect(g.version).toBe(v + 2)
    expect(g.edgesAt(0)).toEqual([])
  })
})

describe('road locations', () => {
  it('maps edge fractions to world positions', () => {
    const g = line()
    expect(g.positionOf({ kind: 'edge', edge: 0, t: 0.25 })).toEqual({ x: 1, y: 0 })
    expect(g.positionOf({ kind: 'node', node: 2 })).toEqual({ x: 8, y: 0 })
  })

  it('finds the nearest location, snapping near nodes', () => {
    const g = line()
    const mid = g.nearestLocation({ x: 2, y: 0.5 }, 1)
    expect(mid?.location).toEqual({ kind: 'edge', edge: 0, t: 0.5 })
    expect(mid?.position).toEqual({ x: 2, y: 0 })
    expect(mid?.distance).toBeCloseTo(0.5)

    expect(g.nearestLocation({ x: 4.2, y: 0.3 }, 1)?.location).toEqual({ kind: 'node', node: 1 })
    expect(g.nearestLocation({ x: 2, y: 5 }, 1)).toBeUndefined()
  })

  it('splits an edge to create a junction, preserving connectivity', () => {
    const g = line()
    const { node, split } = g.ensureNodeAt({ kind: 'edge', edge: 0, t: 0.5 })
    expect(split?.removed).toBe(0)
    expect(g.getEdge(0)).toBeUndefined()
    expect(g.getNode(node)?.position).toEqual({ x: 2, y: 0 })
    expect(g.edgeBetween(0, node)?.length).toBe(2)
    expect(g.edgeBetween(node, 1)?.length).toBe(2)
    // Locations at endpoints resolve to existing nodes without splitting.
    expect(g.ensureNodeAt({ kind: 'edge', edge: 1, t: 0 })).toEqual({ node: 1 })
  })
})

describe('connect', () => {
  it('adds a connection between two mid-edge points on the same original road network', () => {
    // L-shape: 0 —(4,0)— 1 —(4,4)— 2
    const g = RoadGraph.fromLayout({
      nodes: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 4, y: 0 },
        { id: 2, x: 4, y: 4 },
      ],
      segments: [
        { from: 0, to: 1 },
        { from: 1, to: 2 },
      ],
    })
    const result = g.connect({ kind: 'edge', edge: 0, t: 0.5 }, { kind: 'edge', edge: 1, t: 0.5 })
    expect(result.splits).toHaveLength(2)
    const edge = g.getEdge(result.edge)!
    expect(g.positionOf({ kind: 'node', node: edge.a })).toEqual({ x: 2, y: 0 })
    expect(g.positionOf({ kind: 'node', node: edge.b })).toEqual({ x: 4, y: 2 })
    expect(g.edgeCount).toBe(5)
  })

  it('handles both endpoints on edges where the first split changes the second', () => {
    // Two parallel roads: edge 0 along y=0, edge 1 along y=4; connect across.
    const g = RoadGraph.fromLayout({
      nodes: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 8, y: 0 },
        { id: 2, x: 0, y: 4 },
        { id: 3, x: 8, y: 4 },
        { id: 4, x: -2, y: 2 },
      ],
      segments: [
        { from: 0, to: 1 },
        { from: 2, to: 3 },
        { from: 4, to: 0 },
        { from: 4, to: 2 },
      ],
    })
    const { edge } = g.connect({ kind: 'edge', edge: 0, t: 0.75 }, { kind: 'edge', edge: 1, t: 0.75 })
    const e = g.getEdge(edge)!
    expect(e.length).toBeCloseTo(4)
    expect(g.positionOf({ kind: 'node', node: e.b })).toEqual({ x: 6, y: 4 })
  })

  it('rejects zero-length and duplicate connections without mutating', () => {
    const g = line()
    const before = g.version
    expect(g.canConnect({ kind: 'node', node: 1 }, { kind: 'edge', edge: 0, t: 1 })).toEqual({ ok: false, reason: 'zero-length' })
    expect(g.canConnect({ kind: 'node', node: 0 }, { kind: 'node', node: 1 })).toEqual({ ok: false, reason: 'duplicate' })
    expect(g.canConnect({ kind: 'edge', edge: 0, t: 0.1 }, { kind: 'edge', edge: 0, t: 0.9 })).toEqual({ ok: false, reason: 'duplicate' })
    expect(g.canConnect({ kind: 'node', node: 0 }, { kind: 'edge', edge: 0, t: 0.5 })).toEqual({ ok: false, reason: 'duplicate' })
    expect(g.canConnect({ kind: 'node', node: 0 }, { kind: 'node', node: 42 })).toEqual({ ok: false, reason: 'unknown-location' })
    expect(() => g.connect({ kind: 'node', node: 0 }, { kind: 'node', node: 1 })).toThrow(/duplicate/)
    expect(g.version).toBe(before)
  })

  it('allows connecting two nodes that are not yet adjacent', () => {
    const g = line()
    expect(g.canConnect({ kind: 'node', node: 0 }, { kind: 'node', node: 2 })).toEqual({ ok: true })
    const { edge, splits } = g.connect({ kind: 'node', node: 0 }, { kind: 'node', node: 2 })
    expect(splits).toEqual([])
    expect(g.getEdge(edge)?.length).toBe(8)
  })
})


describe('crossing junction construction (#29)', () => {
  it('splits an existing road and connects the new road at a crossing', () => {
    const g = RoadGraph.fromLayout({ nodes: [
      { id: 0, x: 0, y: 0 }, { id: 1, x: 8, y: 0 },
      { id: 2, x: 4, y: -4 }, { id: 3, x: 4, y: 4 },
    ], segments: [{ from: 0, to: 1 }] })
    const result = g.connect({ kind: 'node', node: 2 }, { kind: 'node', node: 3 })
    expect(result.splits).toHaveLength(1)
    expect(result.nodes).toHaveLength(3)
    const junction = result.nodes[1]!
    expect(g.getNode(junction)?.position).toEqual({ x: 4, y: 0 })
    expect(g.edgesAt(junction)).toHaveLength(4)
  })

  it('splits one original edge at several crossings in path order', () => {
    const g = RoadGraph.fromLayout({ nodes: [
      { id: 0, x: 0, y: 0 }, { id: 1, x: 8, y: 0 },
      { id: 2, x: 1, y: -2 }, { id: 3, x: 7, y: -2 },
    ], segments: [{ from: 0, to: 1 }] })
    const result = g.connect({ kind: 'node', node: 2 }, { kind: 'node', node: 3 }, {},
      [{ x: 3, y: 2 }, { x: 5, y: -2 }])
    expect(result.splits).toHaveLength(3)
    const junctions = result.nodes.filter((id) => g.edgesAt(id).length === 4)
    expect(junctions.map((id) => g.getNode(id)?.position.x)).toEqual([2, 4, 6])
    expect(result.nodes).toHaveLength(7)
  })

  it('does not mutate the live graph when the planned connection fails', () => {
    const g = RoadGraph.fromLayout({ nodes: [
      { id: 0, x: 0, y: 0 }, { id: 1, x: 8, y: 0 },
      { id: 2, x: 4, y: -4 }, { id: 3, x: 4, y: 4 },
    ], segments: [{ from: 0, to: 1 }] })
    const before = g.toLayout(), version = g.version
    expect(() => g.connect({ kind: 'node', node: 2 }, { kind: 'node', node: 3 }, { speedLimit: -1 })).toThrow()
    expect(g.toLayout()).toEqual(before)
    expect(g.version).toBe(version)
  })
})
