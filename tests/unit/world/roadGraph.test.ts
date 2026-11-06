import { describe, expect, it } from 'vitest'
import { createRoadGraph, findRoute, generateWorld } from '@game/index'
import { SEEDS } from './helpers'

describe.each(SEEDS.slice(0, 20))('world → road graph (seed %i)', (seed) => {
  const world = generateWorld(seed)
  const graph = createRoadGraph(world)

  it('contains every settlement and portal node', () => {
    for (const x of [...world.settlements, ...world.portals]) expect(graph.hasNode(x.nodeId)).toBe(true)
  })

  it('preserves total road length', () => {
    const worldLength = world.roads.segments.reduce((sum, s) => sum + s.length, 0)
    const graphLength = graph.toLayout().segments.reduce((sum, s) => {
      const nodes = graph.toLayout().nodes
      const a = nodes.find((n) => n.id === s.from)!
      const b = nodes.find((n) => n.id === s.to)!
      return sum + Math.hypot(a.x - b.x, a.y - b.y)
    }, 0)
    expect(graphLength).toBeCloseTo(worldLength)
  })

  it('routes between every pair of portals and settlements', () => {
    const ids = [...world.portals, ...world.settlements].map((x) => x.nodeId)
    for (const a of ids) {
      for (const b of ids) {
        if (a !== b) expect(findRoute(graph, a, b).ok).toBe(true)
      }
    }
  })
})

describe('world → road graph', () => {
  it('does not modify the world', () => {
    const world = generateWorld(11)
    const before = JSON.stringify(world)
    createRoadGraph(world)
    expect(JSON.stringify(world)).toBe(before)
  })
})
