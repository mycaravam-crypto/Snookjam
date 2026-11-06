import { describe, expect, it } from 'vitest'
import { RoadGraph } from '../../../src/game/roads'
import {
  mixedVehicleMinGap,
  TrafficSim,
  VEHICLE_PROFILES,
  type VehicleClass,
} from '../../../src/game/sim'
import { createBalance, maxVehiclesFor, vehicleMixFor } from '../../../src/game/session/balance'

function corridor(): RoadGraph {
  return RoadGraph.fromLayout({
    nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 8, y: 0 }],
    segments: [{ from: 0, to: 1, speedLimit: 2 }],
  })
}

function simulation(kind: VehicleClass): TrafficSim {
  return new TrafficSim(corridor(), {
    portals: [0, 1],
    random: { next: () => 0 },
    startingVehicles: 1,
    spawnIntervalSec: 1000,
    vehicleMix: { car: kind === 'car' ? 1 : 0, van: kind === 'van' ? 1 : 0, truck: kind === 'truck' ? 1 : 0 },
  })
}

describe('vehicle classes (#23)', () => {
  it('defines distinct dimensions and progressively lower speeds', () => {
    expect(VEHICLE_PROFILES.van.length).toBeGreaterThan(VEHICLE_PROFILES.car.length)
    expect(VEHICLE_PROFILES.truck.length).toBeGreaterThan(VEHICLE_PROFILES.van.length)
    expect(VEHICLE_PROFILES.car.speedFactor).toBeGreaterThan(VEHICLE_PROFILES.van.speedFactor)
    expect(VEHICLE_PROFILES.van.speedFactor).toBeGreaterThan(VEHICLE_PROFILES.truck.speedFactor)
    expect(VEHICLE_PROFILES.truck.width).toBeLessThan(0.38 - 0.06)
  })

  it.each(['car', 'van', 'truck'] as const)('spawns and moves a configured %s deterministically', (kind) => {
    const first = simulation(kind)
    const second = simulation(kind)
    first.step(1 / 20)
    second.step(1 / 20)
    expect(first.vehicles()[0]?.kind).toBe(kind)
    expect(first.vehicles()).toEqual(second.vehicles())
    first.step(1 / 20)
    expect(first.vehicles()[0]?.speed).toBeCloseTo(2 * VEHICLE_PROFILES[kind].speedFactor)
  })

  it('uses a conservative gap that accommodates the longest vehicle', () => {
    expect(mixedVehicleMinGap()).toBeGreaterThan(VEHICLE_PROFILES.truck.length)
    const sim = simulation('truck')
    expect(sim.minGap).toBeGreaterThanOrEqual(mixedVehicleMinGap())
  })

  it('increases van and truck shares gradually without reducing the car floor', () => {
    const balance = createBalance()
    const early = vehicleMixFor(balance, 1)
    const later = vehicleMixFor(balance, 5)
    expect(maxVehiclesFor(balance, 5)).toBeGreaterThan(maxVehiclesFor(balance, 1))
    expect(later.van).toBeGreaterThan(early.van)
    expect(later.truck).toBeGreaterThan(early.truck)
    expect(later.car).toBeGreaterThanOrEqual(0.25)
    expect(early.car + early.van + early.truck).toBeCloseTo(1)
    expect(later.car + later.van + later.truck).toBeCloseTo(1)
  })

  it('rejects an empty or negative vehicle mix', () => {
    expect(() => simulation('car').setVehicleMix({ car: 0, van: 0, truck: 0 })).toThrow(/positive weight/)
    expect(() => simulation('car').setVehicleMix({ car: -1, van: 1, truck: 1 })).toThrow(/non-negative/)
  })
})
