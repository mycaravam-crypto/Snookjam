/**
 * Vehicle classes (#23): cars, vans and trucks as plain simulation data.
 *
 * Dimensions are in tiles and speeds are factors on the road's speed limit,
 * so they are independent of sprites and screen size. The renderer may use
 * `length`/`width` to size a vehicle, but traffic rules must only use these
 * values, never artwork.
 *
 * Space a vehicle takes in a queue = its `length` + the configured gap. A car
 * is 0.6 tiles, so with a 0.4-tile gap it occupies exactly the 1-tile
 * spacing the single-class simulation used before #23.
 */
import type { RandomSource } from './traffic'

export type VehicleClassId = 'car' | 'van' | 'truck'

export interface VehicleClass {
  readonly id: VehicleClassId
  /** Bumper-to-bumper length in tiles. */
  readonly length: number
  /** Body width in tiles; must fit inside one lane. */
  readonly width: number
  /** Cruising speed as a fraction of the road's speed limit (0, 1]. */
  readonly speedFactor: number
  /** Multiplier on the time an intersection stays occupied after it crosses. */
  readonly junctionClearFactor: number
}

/** Fixed order used for weighted selection, so a seed always picks the same class. */
export const VEHICLE_CLASS_ORDER: readonly VehicleClassId[] = Object.freeze(['car', 'van', 'truck'])

export const DEFAULT_VEHICLE_CLASSES: Readonly<Record<VehicleClassId, VehicleClass>> = Object.freeze({
  car: Object.freeze({ id: 'car', length: 0.6, width: 0.3, speedFactor: 1, junctionClearFactor: 1 }),
  van: Object.freeze({ id: 'van', length: 0.85, width: 0.34, speedFactor: 0.85, junctionClearFactor: 1.25 }),
  truck: Object.freeze({ id: 'truck', length: 1.4, width: 0.4, speedFactor: 0.65, junctionClearFactor: 1.8 }),
})

/** Default gap in tiles between one vehicle's rear and the next one's front. */
export const DEFAULT_VEHICLE_GAP = 0.4

/** Relative weights of each class among new spawns; need not sum to 1. */
export type VehicleMix = Readonly<Record<VehicleClassId, number>>

export const CARS_ONLY: VehicleMix = Object.freeze({ car: 1, van: 0, truck: 0 })

/** Queue space a vehicle of `cls` occupies: its length plus the gap behind it. */
export function queueSpace(cls: VehicleClass, gap = DEFAULT_VEHICLE_GAP): number {
  return cls.length + gap
}

export function validateVehicleClass(cls: VehicleClass): void {
  if (!(cls.length > 0) || !Number.isFinite(cls.length)) throw new RangeError(`${cls.id}: length must be positive`)
  if (!(cls.width > 0) || !Number.isFinite(cls.width)) throw new RangeError(`${cls.id}: width must be positive`)
  if (!(cls.speedFactor > 0 && cls.speedFactor <= 1)) throw new RangeError(`${cls.id}: speedFactor must be in (0, 1]`)
  if (!(cls.junctionClearFactor >= 1) || !Number.isFinite(cls.junctionClearFactor)) {
    throw new RangeError(`${cls.id}: junctionClearFactor must be at least 1`)
  }
}

export function validateMix(mix: VehicleMix): void {
  let total = 0
  for (const id of VEHICLE_CLASS_ORDER) {
    const w = mix[id]
    if (!(w >= 0) || !Number.isFinite(w)) throw new RangeError(`mix weight for ${id} must be a non-negative number`)
    total += w
  }
  if (!(total > 0)) throw new RangeError('mix must have at least one positive weight')
}

/** Share (0..1) of each class in a mix. */
export function mixShares(mix: VehicleMix): Record<VehicleClassId, number> {
  validateMix(mix)
  const total = VEHICLE_CLASS_ORDER.reduce((sum, id) => sum + mix[id], 0)
  return { car: mix.car / total, van: mix.van / total, truck: mix.truck / total }
}

/**
 * Picks a class by weight with exactly one draw from `random`, iterating in
 * VEHICLE_CLASS_ORDER, so results are reproducible for a seed.
 */
export function pickVehicleClass(
  mix: VehicleMix,
  random: RandomSource,
  classes: Readonly<Record<VehicleClassId, VehicleClass>> = DEFAULT_VEHICLE_CLASSES,
): VehicleClass {
  validateMix(mix)
  const total = VEHICLE_CLASS_ORDER.reduce((sum, id) => sum + mix[id], 0)
  let r = random.next() * total
  for (const id of VEHICLE_CLASS_ORDER) {
    if (mix[id] <= 0) continue
    if (r < mix[id]) return classes[id]
    r -= mix[id]
  }
  // Floating-point remainder: fall back to the last class with weight.
  const last = [...VEHICLE_CLASS_ORDER].reverse().find((id) => mix[id] > 0)!
  return classes[last]
}
