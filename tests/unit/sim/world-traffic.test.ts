import { describe, expect, it } from 'vitest'
import { TrafficSim, createRng, createRoadGraph, generateWorld } from '../../../src/game'

/** Runs traffic on a generated world for `seconds` of simulated time. */
function play(seed: number, seconds: number) {
  const world = generateWorld(seed)
  const graph = createRoadGraph(world)
  const sim = new TrafficSim(graph, { portals: world.portals.map((p) => p.nodeId), random: createRng(seed) })
  for (let i = 0; i < seconds * 20; i++) sim.step(1 / 20)
  return { world, graph, sim }
}

describe('traffic on generated worlds', () => {
  it.each([1, 2, 3, 42, 1234])('spawns, moves and exits vehicles on seed %i', (seed) => {
    const { sim } = play(seed, 120)
    const stats = sim.stats()
    expect(stats.totalSpawned).toBeGreaterThan(8)
    expect(stats.totalExited).toBeGreaterThan(0)
    expect(stats.totalUnroutable).toBe(0) // generated maps connect all portals
    expect(stats.stuck).toBe(0)
  })

  it('is reproducible for a seed', () => {
    const a = play(7, 60).sim
    const b = play(7, 60).sim
    expect(b.stats()).toEqual(a.stats())
    expect(b.vehicles().map((v) => [v.id, v.progress])).toEqual(a.vehicles().map((v) => [v.id, v.progress]))
  })

  it('places every vehicle on the road network', () => {
    const { sim, graph } = play(3, 60)
    for (const v of sim.vehicles()) {
      const { position } = sim.positionOf(v)
      expect(graph.nearestLocation(position, 1e-6)).toBeDefined()
    }
  })
})
