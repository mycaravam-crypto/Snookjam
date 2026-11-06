/**
 * Two-lane road geometry (#22), shared by the simulation and the renderer.
 *
 * Every road is a classic two-lane road: one lane per travel direction,
 * driving on the right, separated by a centre line. All values are in world
 * units (tiles), so they are independent of zoom and sprite artwork.
 *
 *   |<-------------- roadWidth -------------->|
 *   |   lane (→)        ¦        lane (←)     |
 *   |  [ vehicleWidth ] ¦  [ vehicleWidth ]   |
 *          ^ laneOffset from the centre line
 *
 * Opposing vehicles are `2 × laneOffset` apart centre to centre, so the gap
 * between them is `laneWidth − vehicleWidth`, which must be at least
 * `safetyGap`.
 */
export interface RoadGeometry {
  /** Width of one lane. */
  readonly laneWidth: number
  /** Vehicle footprint (for collision checks and rendering). */
  readonly vehicleLength: number
  readonly vehicleWidth: number
  /** Minimum clearance between any two vehicles. */
  readonly safetyGap: number
  /**
   * Vehicles turn on a smooth curve that starts this far before a bend or
   * junction and ends this far after it, so their bodies never swing into
   * the opposite lane. Must exceed `laneWidth / 2`.
   */
  readonly cornerRadius: number
}

export const ROAD_GEOMETRY: RoadGeometry = Object.freeze({
  laneWidth: 0.38,
  vehicleLength: 0.5,
  vehicleWidth: 0.22,
  safetyGap: 0.06,
  cornerRadius: 0.45,
})

/** Full road surface width: two lanes. */
export function roadWidth(g: RoadGeometry = ROAD_GEOMETRY): number {
  return 2 * g.laneWidth
}

/** Distance from the centre line to the middle of a lane. */
export function laneOffset(g: RoadGeometry = ROAD_GEOMETRY): number {
  return g.laneWidth / 2
}

/**
 * Distance before an intersection node at which vehicles stop (measured to
 * the vehicle's centre, along the route). A stopped vehicle's front stays
 * outside the crossing road's surface by `safetyGap`. The extra `laneOffset`
 * covers lanes being mitred toward a turn, which can move a vehicle up to one
 * lane offset closer to the node.
 */
export function junctionStopDistance(g: RoadGeometry = ROAD_GEOMETRY): number {
  return roadWidth(g) / 2 + g.vehicleLength / 2 + g.safetyGap + laneOffset(g)
}

/**
 * Minimum following distance (centre to centre, measured along the road's
 * centre line). It must cover two cars straddling a right-angle bend on the
 * inside lane, where the lane is shorter than the centre line:
 * each car needs half its length, the lane offset, half its width and the
 * safety gap between its centre and the corner.
 */
export function minFollowingDistance(g: RoadGeometry = ROAD_GEOMETRY): number {
  return 2 * (g.vehicleLength / 2 + laneOffset(g) + g.vehicleWidth / 2 + g.safetyGap)
}

/** Throws if the geometry would let opposing or following vehicles touch. */
export function validateRoadGeometry(g: RoadGeometry, minGap: number): void {
  for (const [key, value] of Object.entries(g)) {
    if (!(value > 0) || !Number.isFinite(value)) throw new RangeError(`${key} must be positive`)
  }
  if (g.laneWidth - g.vehicleWidth < g.safetyGap - 1e-9) {
    throw new RangeError('lanes are too narrow for vehicles to pass with the safety gap')
  }
  if (g.cornerRadius <= laneOffset(g)) throw new RangeError('cornerRadius must exceed the lane offset')
  if (minGap < minFollowingDistance(g) - 1e-9) {
    throw new RangeError(`minGap must be at least ${minFollowingDistance(g)} for this road geometry`)
  }
}
