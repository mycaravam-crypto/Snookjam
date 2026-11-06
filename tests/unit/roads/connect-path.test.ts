import { describe, expect, it } from 'vitest'
import { findRoute, RoadGraph } from '@game/index'

/** A square: 0 (0,0) - 1 (10,0) - 2 (10,10) - 3 (0,10). */
function square() {
  return RoadGraph.fromLayout({
    nodes: [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 10, y: 0 },
      { id: 2, x: 10, y: 10 },
      { id: 3, x: 0, y: 10 },
    ],
    segments: [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 0 },
    ],
  })
}

describe('RoadGraph.connect with via points', () => {
  it('builds a chain of edges through new bend nodes', () => {
    const graph = square()
    const via = [
      { x: 3, y: 4 },
      { x: 7, y: 6 },
    ]
    const result = graph.connect({ kind: 'edge', edge: 0, t: 0.5 }, { kind: 'edge', edge: 2, t: 0.5 }, {}, via)
    expect(result.edges).toHaveLength(3)
    expect(result.edge).toBe(result.edges[0])
    expect(result.splits).toHaveLength(2)
    const positions = result.nodes.map((id) => graph.getNode(id)!.position)
    expect(positions).toEqual([{ x: 5, y: 0 }, ...via, { x: 5, y: 10 }])
    const found = findRoute(graph, result.nodes[0]!, result.nodes[3]!)
    expect(found.ok && found.route.steps.map((s) => s.edge)).toEqual(result.edges)
  })

  it('allows a curved road between two points of the same edge', () => {
    const graph = square()
    const result = graph.connect({ kind: 'edge', edge: 0, t: 0.2 }, { kind: 'edge', edge: 0, t: 0.8 }, {}, [{ x: 5, y: 3 }])
    expect(result.edges).toHaveLength(2)
    expect(graph.getNode(result.nodes[0]!)!.position).toEqual({ x: 2, y: 0 })
    expect(graph.getNode(result.nodes[2]!)!.position).toEqual({ x: 8, y: 0 })
  })

  it('still treats a straight road along the same edge as a duplicate', () => {
    const graph = square()
    expect(graph.canConnect({ kind: 'edge', edge: 0, t: 0.2 }, { kind: 'edge', edge: 0, t: 0.8 })).toEqual({
      ok: false,
      reason: 'duplicate',
    })
  })

  it.each([
    ['a zero-length segment', [{ x: 5, y: 0 }], 'zero-length'],
    ['a non-finite bend', [{ x: Number.NaN, y: 3 }], 'invalid-path'],
  ])('rejects %s atomically', (_name, via, reason) => {
    const graph = square()
    const before = graph.toLayout()
    const version = graph.version
    const from = { kind: 'edge', edge: 0, t: 0.5 } as const
    const to = { kind: 'node', node: 2 } as const
    expect(graph.canConnect(from, to, via)).toEqual({ ok: false, reason })
    expect(() => graph.connect(from, to, {}, via)).toThrow(reason)
    expect(graph.version).toBe(version)
    expect(graph.toLayout()).toEqual(before)
  })

  it('rejects a closed loop back to the same point', () => {
    const graph = square()
    expect(graph.canConnect({ kind: 'node', node: 0 }, { kind: 'node', node: 0 }, [{ x: 3, y: 3 }])).toEqual({
      ok: false,
      reason: 'zero-length',
    })
  })
})
