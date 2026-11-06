import { describe, expect, it } from 'vitest'
import {
  CARS_ONLY,
  DEFAULT_VEHICLE_CLASSES,
  DEFAULT_VEHICLE_GAP,
  VEHICLE_CLASS_ORDER,
  VEHICLE_SPACING,
  createRng,
  mixShares,
  pickVehicleClass,
  queueSpace,
  validateMix,
  validateVehicleClass,
  type VehicleMix,
} from '../../../src/game'

const { car, van, truck } = DEFAULT_VEHICLE_CLASSES

describe('vehicle classes', () => {
  it('are valid and ordered car < van < truck in size and slowness', () => {
    for (const id of VEHICLE_CLASS_ORDER) validateVehicleClass(DEFAULT_VEHICLE_CLASSES[id])
    expect(car.length).toBeLessThan(van.length)
    expect(van.length).toBeLessThan(truck.length)
    expect(car.width).toBeLessThanOrEqual(van.width)
    expect(van.width).toBeLessThanOrEqual(truck.width)
    expect(car.speedFactor).toBeGreaterThan(van.speedFactor)
    expect(van.speedFactor).toBeGreaterThan(truck.speedFactor)
    expect(truck.junctionClearFactor).toBeGreaterThan(van.junctionClearFactor)
  })

  it('keeps the pre-#23 one-tile spacing for cars', () => {
    expect(queueSpace(car)).toBeCloseTo(VEHICLE_SPACING)
    expect(queueSpace(truck)).toBeCloseTo(truck.length + DEFAULT_VEHICLE_GAP)
  })

  it('rejects invalid class data', () => {
    expect(() => validateVehicleClass({ ...car, length: 0 })).toThrow(/length/)
    expect(() => validateVehicleClass({ ...car, width: -1 })).toThrow(/width/)
    expect(() => validateVehicleClass({ ...car, speedFactor: 1.5 })).toThrow(/speedFactor/)
    expect(() => validateVehicleClass({ ...car, junctionClearFactor: 0.5 })).toThrow(/junctionClearFactor/)
  })
})

describe('vehicle mix', () => {
  it('validates weights', () => {
    expect(() => validateMix({ car: 0, van: 0, truck: 0 })).toThrow()
    expect(() => validateMix({ car: 1, van: -1, truck: 0 })).toThrow()
    expect(() => validateMix({ car: 1, van: Number.NaN, truck: 0 })).toThrow()
    expect(mixShares({ car: 3, van: 1, truck: 0 })).toEqual({ car: 0.75, van: 0.25, truck: 0 })
  })

  it('picks deterministically for a seed with one draw per pick', () => {
    const mix: VehicleMix = { car: 6, van: 3, truck: 1 }
    const run = () => {
      const rng = createRng(123)
      return Array.from({ length: 200 }, () => pickVehicleClass(mix, rng).id)
    }
    expect(run()).toEqual(run())
    // One draw per pick: the 201st draw matches a fresh rng advanced 200 times.
    const a = createRng(9)
    const b = createRng(9)
    for (let i = 0; i < 200; i++) {
      pickVehicleClass(mix, a)
      b.next()
    }
    expect(a.next()).toBe(b.next())
  })

  it('follows the weights over many picks and never picks zero-weight classes', () => {
    const rng = createRng(7)
    const counts = { car: 0, van: 0, truck: 0 }
    for (let i = 0; i < 20000; i++) counts[pickVehicleClass({ car: 60, van: 25, truck: 15 }, rng).id]++
    expect(counts.car / 20000).toBeCloseTo(0.6, 1)
    expect(counts.van / 20000).toBeCloseTo(0.25, 1)
    expect(counts.truck / 20000).toBeCloseTo(0.15, 1)
    const only = createRng(1)
    for (let i = 0; i < 1000; i++) expect(pickVehicleClass(CARS_ONLY, only).id).toBe('car')
  })

  it('handles draws at the edges of [0, 1)', () => {
    const mix: VehicleMix = { car: 1, van: 1, truck: 0 }
    expect(pickVehicleClass(mix, { next: () => 0 }).id).toBe('car')
    expect(pickVehicleClass(mix, { next: () => 0.9999999999 }).id).toBe('van')
  })
})
