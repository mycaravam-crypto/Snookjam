/**
 * Continuous driving through sharp degree-2 bends.
 */
import { describe, expect, it } from 'vitest'
import { RoadGraph } from '../../../src/game/roads'
import { TrafficSim, VEHICLE_PROFILES } from '../../../src/game/sim'
import { collisions } from './footprint'

const DT = 1 / 20

function sharpBend(): RoadGraph {
  return RoadGraph.fromLayout({
    nodes: [
      { id: 0, x: -8, y: 0 },
      { id: 1, x: 0, y: 0 },
      { id: 2, x: -4, y: -4 },
    ],
    segments: [
      { from: 0, to: 1, capacity: 20 },
      { from: 1, to: 2, capacity: 20 },
    ],
  })
}

describe('continuous corner driving', () => {
  it('accelerates and brakes progressively through a bend', () => {
    const graph = sharpBend()
    const sim = new TrafficSim(graph, {
      portals: [0, 2],
      random: { next: () => 0.37 },
      startingVehicles: 1,
      maxVehicles: 1,
      spawnIntervalSec: 1000,
    })
    const speeds: number[] = []
    for (let i = 0; i < 20 * 12 && sim.vehicles().length > 0; i++) {
      sim.step(DT)
      const vehicle = sim.vehicles()[0]
      if (vehicle) speeds.push(vehicle.speed)
    }

    const profile = VEHICLE_PROFILES.car
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]! - speeds[i - 1]!).toBeLessThanOrEqual(profile.accel * DT + 1e-9)
      expect(speeds[i - 1]! - speeds[i]!).toBeLessThanOrEqual(profile.decel * DT + 1e-9)
    }
    expect(Math.min(...speeds)).toBeLessThan(1.95)
    expect(speeds.at(-1)).toBeCloseTo(2, 1)
  })

  it('slows through a sharp bend without reserving or stopping at a junction', () => {
    const graph = sharpBend()
    const sim = new TrafficSim(graph, {
      portals: [0, 2],
      random: { next: () => 0.37 },
      startingVehicles: 4,
      maxVehicles: 4,
      spawnIntervalSec: 1000,
    })

    expect(sim.junctionAt(1)).toBeUndefined()

    const bendSpeeds: number[] = []
    for (let i = 0; i < 20 * 30; i++) {
      sim.step(DT)
      expect(collisions(sim)).toEqual([])

      for (const vehicle of sim.vehicles()) {
        const step = vehicle.steps[vehicle.stepIndex]!
        const edge = graph.getEdge(step.edge)!
        const inCorner =
          (vehicle.stepIndex === 0 && edge.length - vehicle.progress <= 0.7) ||
          (vehicle.stepIndex === 1 && vehicle.progress <= 0.7)
        if (inCorner && vehicle.state === 'moving') {
          bendSpeeds.push(vehicle.speed)
          expect(vehicle.speed).toBeGreaterThan(0)
        }
      }
    }

    expect(bendSpeeds.length).toBeGreaterThan(0)
    expect(Math.min(...bendSpeeds)).toBeLessThan(1.2)
    expect(sim.stats().stuck).toBe(0)
    expect(sim.stats().totalExited).toBeGreaterThan(0)
  })
})
