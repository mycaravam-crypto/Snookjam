/**
 * Road removal and undo/redo (#33).
 */
import { describe, expect, it } from 'vitest'
import { GameSession, MAX_EDIT_HISTORY, RoadEditor } from '@game/index'
import { RoadGraph } from '../../../src/game/roads'
import { TrafficSim, type RandomSource } from '../../../src/game/sim'
import { collisions } from '../sim/footprint'

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

/**
 * Two parallel generated roads, y = 4 and y = 12, with a tunnel at each end,
 * joined by a generated link at x = 15 (so every trip has a route).
 */
function world(seed = 1, startingVehicles = 0) {
  const graph = RoadGraph.fromLayout({
    nodes: [
      { id: 0, x: 0, y: 4 },
      { id: 1, x: 18, y: 4 },
      { id: 2, x: 0, y: 12 },
      { id: 3, x: 18, y: 12 },
      { id: 4, x: 15, y: 4 },
      { id: 5, x: 15, y: 12 },
    ],
    segments: [
      { from: 0, to: 4 },
      { from: 4, to: 1 },
      { from: 2, to: 5 },
      { from: 5, to: 3 },
      { from: 4, to: 5 },
    ],
  })
  const sim = new TrafficSim(graph, { portals: [0, 1, 2, 3], random: rng(seed), startingVehicles, spawnIntervalSec: 1000 })
  return { graph, sim, editor: new RoadEditor(graph, sim) }
}

/** Order-independent picture of the network: rounded node positions and edge segments. */
function shape(graph: RoadGraph): { nodes: string[]; edges: string[] } {
  const key = (p: { x: number; y: number }) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`
  return {
    nodes: graph.nodes().map((n) => key(n.position)).sort(),
    edges: graph
      .edges()
      .map((e) => [key(graph.getNode(e.a)!.position), key(graph.getNode(e.b)!.position)].sort().join(' – ') + (e.blocked ? ' blocked' : ''))
      .sort(),
  }
}

const at = (graph: RoadGraph, x: number, y: number) => graph.nearestLocation({ x, y }, 1e-6, 1e-6)!.location

/**
 * A: (4,4) to (4,12), splitting both generated roads. B: a dead end from
 * (12,4) to (12,8). C: from B's dead end west to (2,8), crossing A.
 */
function buildThree(e: ReturnType<typeof world>) {
  const { graph, editor } = e
  editor.build(at(graph, 4, 4), at(graph, 4, 12), [])
  editor.build(at(graph, 12, 4), { x: 12, y: 8 }, [])
  editor.build(at(graph, 12, 8), { x: 2, y: 8 }, [])
}

describe('RoadGraph.removeEdges (#33)', () => {
  it('removes a road and merges the edges it split back into one', () => {
    const { graph, editor } = world()
    const before = shape(graph)
    editor.build(at(graph, 4, 4), at(graph, 4, 12), [])
    expect(graph.edgeCount).toBe(8)
    const result = graph.removeEdges(graph.roadEdges(1).map((e) => e.id))
    expect(result.merges).toHaveLength(2)
    expect(shape(graph)).toEqual(before)
  })

  it('keeps a bend of another road as a node', () => {
    const { graph, editor } = world()
    // A freehand road with a bend at (8,8), then a road from that bend to the bottom road.
    editor.build(at(graph, 4, 4), at(graph, 12, 4), [{ x: 8, y: 8 }])
    editor.build(at(graph, 8, 8), at(graph, 8, 12), [])
    const withBoth = shape(graph)
    graph.removeEdges(graph.roadEdges(2).map((e) => e.id))
    expect(graph.edgesAt(graph.nearestLocation({ x: 8, y: 8 }, 1e-6, 1e-6)!.location.kind === 'node' ? (graph.nearestLocation({ x: 8, y: 8 }, 1e-6, 1e-6)!.location as { node: number }).node : -1)).toHaveLength(2)
    expect(shape(graph).edges.length).toBeLessThan(withBoth.edges.length)
  })

  it('is atomic: an unknown edge changes nothing', () => {
    const { graph, editor } = world()
    editor.build(at(graph, 4, 4), at(graph, 4, 12), [])
    const before = shape(graph)
    const version = graph.version
    expect(() => graph.removeEdges([...graph.roadEdges(1).map((e) => e.id), 999])).toThrow()
    expect(shape(graph)).toEqual(before)
    expect(graph.version).toBe(version)
  })
})

describe('undo and redo (#33)', () => {
  it('undo restores the exact network, redo rebuilds it, across junctions and dead ends', () => {
    const e = world()
    const stages = [shape(e.graph)]
    e.editor.build(at(e.graph, 4, 4), at(e.graph, 4, 12), [])
    stages.push(shape(e.graph))
    e.editor.build(at(e.graph, 12, 4), { x: 12, y: 8 }, [])
    stages.push(shape(e.graph))
    e.editor.build(at(e.graph, 12, 8), { x: 2, y: 8 }, [])
    stages.push(shape(e.graph))
    // C crosses A: a four-way junction at (4,8).
    expect(e.graph.edgesAt((at(e.graph, 4, 8) as { node: number }).node)).toHaveLength(4)

    for (let i = 3; i > 0; i--) {
      expect(e.editor.undo()).toMatchObject({ ok: true, action: 'removed' })
      expect(shape(e.graph)).toEqual(stages[i - 1])
    }
    expect(e.editor.canUndo).toBe(false)
    expect(e.editor.undo()).toEqual({ ok: false, reason: 'nothing-to-undo' })
    expect(e.editor.roads()).toHaveLength(0)

    for (let i = 1; i <= 3; i++) {
      expect(e.editor.redo()).toMatchObject({ ok: true, action: 'built' })
      expect(shape(e.graph)).toEqual(stages[i])
    }
    expect(e.editor.redo()).toEqual({ ok: false, reason: 'nothing-to-redo' })
    expect(e.editor.roads().map((r) => r.id)).toEqual([1, 2, 3])
  })

  it('a new build clears the redo history', () => {
    const e = world()
    e.editor.build(at(e.graph, 4, 4), at(e.graph, 4, 12), [])
    e.editor.undo()
    expect(e.editor.canRedo).toBe(true)
    e.editor.build(at(e.graph, 10, 4), at(e.graph, 10, 12), [])
    expect(e.editor.canRedo).toBe(false)
  })

  it('removing a road can be undone and redone', () => {
    const e = world()
    buildThree(e)
    const full = shape(e.graph)
    // Remove the middle road B: C's start becomes a dead end at (12,8).
    expect(e.editor.remove(2)).toMatchObject({ ok: true, action: 'removed' })
    const without = shape(e.graph)
    expect(e.editor.roads().map((r) => r.id)).toEqual([1, 3])
    expect(e.editor.undo()).toMatchObject({ ok: true, action: 'built' })
    expect(shape(e.graph)).toEqual(full)
    expect(e.editor.redo()).toMatchObject({ ok: true, action: 'removed' })
    expect(shape(e.graph)).toEqual(without)
  })

  it('keeps the history bounded', () => {
    const e = world()
    for (let i = 0; i < MAX_EDIT_HISTORY + 10; i++) {
      e.editor.build(at(e.graph, 0.5 + i * 0.2, 4), { x: 0.5 + i * 0.2, y: 6 }, [])
    }
    let undone = 0
    while (e.editor.undo().ok) undone++
    expect(undone).toBe(MAX_EDIT_HISTORY)
    expect(e.editor.roads()).toHaveLength(10)
  })

  it('only removes player roads', () => {
    const e = world()
    expect(e.editor.remove(1)).toEqual({ ok: false, reason: 'not-found' })
    expect(e.editor.roadAt({ x: 8, y: 4.1 }, 0.5)).toBeUndefined() // generated road
    e.editor.build(at(e.graph, 4, 4), at(e.graph, 4, 12), [])
    expect(e.editor.roadAt({ x: 4.3, y: 8 }, 0.5)?.id).toBe(1)
  })
})

describe('removing occupied roads (#33)', () => {
  /** Builds the shortcut, then runs until a vehicle is driving on it. */
  function occupied(seed: number) {
    const e = world(seed)
    // A diagonal shortcut from the top road to the bottom road that west-to-east traffic uses.
    e.editor.build(at(e.graph, 2, 4), at(e.graph, 14, 12), [])
    e.sim.queueSpawns(12)
    e.sim.setSpawnInterval(1.2)
    for (let i = 0; i < 20 * 60 && !e.editor.isOccupied(1); i++) e.sim.step(DT)
    expect(e.editor.isOccupied(1)).toBe(true)
    return e
  }

  it('closes the road, lets vehicles drive off without jumps or overlaps, then removes it', () => {
    const e = occupied(1)
    const before = shape(e.graph)
    expect(e.editor.remove(1)).toEqual({ ok: true, action: 'closing', road: 1 })
    expect(e.editor.road(1)?.state).toBe('closing')
    // Closed: no route uses it, but it is still there.
    expect(e.graph.roadEdges(1).every((edge) => edge.blocked)).toBe(true)
    expect(shape(e.graph).edges.length).toBe(before.edges.length)

    const last = new Map(e.sim.vehicles().map((v) => [v.id, e.sim.positionOf(v).position]))
    let removedAt = -1
    for (let i = 0; i < 20 * 60; i++) {
      e.sim.step(DT)
      e.editor.update()
      for (const v of e.sim.vehicles()) {
        const p = e.sim.positionOf(v).position
        const q = last.get(v.id)
        // Never faster than the speed limit allows: nobody teleports.
        if (q) expect(Math.hypot(p.x - q.x, p.y - q.y), `vehicle ${v.id} at step ${i}`).toBeLessThan(2 * DT + 1e-6)
        last.set(v.id, p)
      }
      if (i % 2 === 0) expect(collisions(e.sim)).toEqual([])
      if (removedAt < 0 && e.editor.road(1)?.state === 'removed') removedAt = i
    }
    expect(removedAt).toBeGreaterThan(0)
    expect(e.graph.roadEdges(1)).toHaveLength(0)
    expect(e.sim.stats().stuck).toBe(0)
  })

  it('undo while closing reopens the road', () => {
    const e = occupied(2)
    const before = shape(e.graph)
    expect(e.editor.remove(1).ok).toBe(true)
    expect(e.editor.undo()).toEqual({ ok: true, action: 'reopened', road: 1 })
    expect(shape(e.graph)).toEqual(before)
    expect(e.editor.road(1)?.state).toBe('open')
  })

  it('migrates vehicles on edges merged back together', () => {
    const e = world(3)
    e.editor.build(at(e.graph, 8, 4), at(e.graph, 8, 12), [])
    e.sim.queueSpawns(10)
    e.sim.setSpawnInterval(1)
    // Run until someone is on a half of a generated road the shortcut split.
    for (let i = 0; i < 20 * 60; i++) {
      e.sim.step(DT)
      const onHalf = e.sim.vehicles().some((v) => e.graph.getEdge(v.steps[v.stepIndex]!.edge)!.road === undefined)
      if (onHalf && !e.editor.isOccupied(1)) break
    }
    const positions = new Map(e.sim.vehicles().map((v) => [v.id, e.sim.positionOf(v).position]))
    expect(e.editor.remove(1)).toMatchObject({ ok: true, action: 'removed' })
    for (const v of e.sim.vehicles()) {
      const p = e.sim.positionOf(v).position
      expect(p.x).toBeCloseTo(positions.get(v.id)!.x)
      expect(p.y).toBeCloseTo(positions.get(v.id)!.y)
    }
    for (let i = 0; i < 20 * 30; i++) e.sim.step(DT)
    expect(e.sim.stats().stuck).toBe(0)
  })
})

describe('road editing through the game session (#33)', () => {
  it('records roads, edits only while playable, and resets per level', () => {
    const s = new GameSession({ seed: 9 })
    expect(() => s.undo()).toThrow(/ready/)
    s.start()
    expect(s.canUndo).toBe(false)
    const g = s.graph
    const nodes = g.nodes()
    let built = false
    for (const a of nodes) {
      for (const b of nodes) {
        const len = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y)
        if (built || len < 3 || len > 6 || g.edgeBetween(a.id, b.id)) continue
        try {
          s.connectRoad({ kind: 'node', node: a.id }, { kind: 'node', node: b.id })
          built = true
        } catch {
          // not connectable; try the next pair
        }
      }
    }
    expect(built).toBe(true)
    expect(s.roads()).toHaveLength(1)
    expect(s.canUndo).toBe(true)
    const version = s.roadsVersion
    s.pause()
    expect(s.undo().ok).toBe(true)
    expect(s.roadsVersion).toBeGreaterThan(version)
    expect(s.roads().length + s.roads().filter((r) => r.state === 'closing').length).toBeLessThanOrEqual(1)
    s.restart()
    expect(s.roads()).toHaveLength(0)
    expect(s.canUndo).toBe(false)
  })
})

describe('road edits and traffic diagnostics (#33, #34)', () => {
  it('keeps the congestion heatmap on live roads through builds, removals and undo', () => {
    const s = new GameSession({ seed: 9 })
    s.start()
    // Build a road between two nodes so it splits nothing, then one mid-edge so it splits.
    const g = s.graph
    let built = 0
    for (const a of g.nodes()) {
      for (const b of g.nodes()) {
        const len = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y)
        if (built >= 2 || len < 3 || len > 6 || g.edgeBetween(a.id, b.id)) continue
        try {
          s.connectRoad({ kind: 'node', node: a.id }, { kind: 'node', node: b.id })
          built++
        } catch {
          // not connectable
        }
      }
    }
    expect(built).toBe(2)
    const live = () => s.diagnostics.roads().every((r) => s.graph.getEdge(r.edge) !== undefined)
    for (let i = 0; i < 20 * 40; i++) {
      s.tick()
      s.setCongestionForTesting(0)
    }
    expect(live()).toBe(true)
    for (const road of s.roads()) s.removeRoad(road.id)
    expect(live()).toBe(true)
    for (let i = 0; i < 20 * 40 && s.roads().length > 0; i++) {
      s.tick()
      s.setCongestionForTesting(0)
      expect(live()).toBe(true)
    }
    expect(s.roads()).toHaveLength(0)
    while (s.canUndo) s.undo()
    expect(live()).toBe(true)
  })
})
