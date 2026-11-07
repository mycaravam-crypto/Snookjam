import { ROAD_GEOMETRY, type TrafficSim, type Vehicle } from '@game/index'

type Corner = readonly [number, number]

/** Oriented rectangle of a vehicle in its lane, in world units. */
export function footprint(sim: TrafficSim, v: Vehicle, g = ROAD_GEOMETRY): Corner[] {
  const { position: p, heading: h } = sim.lanePositionOf(v)
  const c = Math.cos(h)
  const s = Math.sin(h)
  const L = g.vehicleLength / 2
  const W = g.vehicleWidth / 2
  return [
    [L, W],
    [-L, W],
    [-L, -W],
    [L, -W],
  ].map(([a, b]) => [p.x + a! * c - b! * s, p.y + a! * s + b! * c] as const)
}

/** Separating-axis test: true if the rectangles overlap by more than `eps`. */
export function overlaps(A: Corner[], B: Corner[], eps = 1e-6): boolean {
  for (const P of [A, B]) {
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = P[i]!
      const [x2, y2] = P[(i + 1) % 4]!
      const len = Math.hypot(x2 - x1, y2 - y1)
      const nx = (y2 - y1) / len
      const ny = (x1 - x2) / len
      const pa = A.map(([x, y]) => x * nx + y * ny)
      const pb = B.map(([x, y]) => x * nx + y * ny)
      if (Math.max(...pa) <= Math.min(...pb) + eps || Math.max(...pb) <= Math.min(...pa) + eps) return false
    }
  }
  return true
}

/** Pairs of vehicles whose footprints overlap. */
export function collisions(sim: TrafficSim, g = ROAD_GEOMETRY): [Vehicle, Vehicle][] {
  const vs = sim.vehicles().map((v) => ({ v, box: footprint(sim, v, g) }))
  const out: [Vehicle, Vehicle][] = []
  for (let i = 0; i < vs.length; i++) {
    for (let j = i + 1; j < vs.length; j++) {
      if (overlaps(vs[i]!.box, vs[j]!.box)) out.push([vs[i]!.v, vs[j]!.v])
    }
  }
  return out
}
