import { EPSILON, type NearestLocation, type Point, type RoadEdge, type RoadGraph, type RoadLocation } from '../roads/graph'
import { isPassable, terrainAt, type World } from '../world/types'

export interface ConstructionOptions {
  /** How far (tiles) from a road a pointer may be and still snap to it. */
  readonly snapDistance: number
  /** Within this distance (tiles) of a node, snap to the node itself. */
  readonly nodeSnap: number
  /** Shortest road the player may build, in tiles. */
  readonly minLength: number
  /** Longest road the player may build, in tiles (Infinity = no limit). */
  readonly maxLength: number
  /** Half the drawn road width, used when checking terrain under the road. */
  readonly halfWidth: number
}

export const DEFAULT_CONSTRUCTION_OPTIONS: ConstructionOptions = Object.freeze({
  snapDistance: 0.75,
  nodeSnap: 0.5,
  minLength: 1,
  maxLength: Infinity,
  halfWidth: 0.2,
})

export type RejectionReason =
  | 'not-on-road'
  | 'not-connected'
  | 'off-map'
  | 'too-short'
  | 'too-long'
  | 'duplicate'
  | 'obstacle'
  | 'crosses-road'

/** Player-facing explanation for each rejection. */
export const REJECTION_MESSAGES: Record<RejectionReason, string> = {
  'not-on-road': 'Start on an existing road',
  'not-connected': 'End on an existing road',
  'off-map': 'Roads must stay on the map',
  'too-short': 'Too short to build',
  'too-long': 'Too long to build',
  duplicate: 'There is already a road here',
  obstacle: 'Roads cannot cross water',
  'crosses-road': 'Roads may only meet at their ends',
}

export type ConnectionCheck =
  | { readonly ok: true; readonly from: NearestLocation; readonly to: NearestLocation }
  | {
      readonly ok: false
      readonly reason: RejectionReason
      /** Snapped start, when the start was on a road. */
      readonly from?: NearestLocation
      /** Snapped end, when the end was on a road. */
      readonly to?: NearestLocation
    }

/** Snaps a world point to the road network, or undefined if too far away. */
export function snapToRoad(
  graph: RoadGraph,
  point: Point,
  options: ConstructionOptions = DEFAULT_CONSTRUCTION_OPTIONS,
): NearestLocation | undefined {
  return graph.nearestLocation(point, options.snapDistance, options.nodeSnap)
}

/**
 * Validates a road from `start` to `end` (world points, unsnapped). Both ends
 * must snap to the existing network; the straight road between the snapped
 * positions must stay on the map, avoid impassable terrain, not cross other
 * roads except at its ends, and not duplicate an existing road.
 * Never mutates the graph.
 */
export function checkConnection(
  world: World,
  graph: RoadGraph,
  start: Point,
  end: Point,
  options: ConstructionOptions = DEFAULT_CONSTRUCTION_OPTIONS,
): ConnectionCheck {
  const from = snapToRoad(graph, start, options)
  if (!from) return { ok: false, reason: 'not-on-road' }
  const to = snapToRoad(graph, end, options)
  if (!to) return { ok: false, reason: 'not-connected', from }

  const a = from.position
  const b = to.position
  const length = Math.hypot(b.x - a.x, b.y - a.y)
  if (length < options.minLength) return { ok: false, reason: 'too-short', from, to }
  if (length > options.maxLength) return { ok: false, reason: 'too-long', from, to }

  const graphCheck = graph.canConnect(from.location, to.location)
  if (!graphCheck.ok) {
    const reason = graphCheck.reason === 'zero-length' ? 'too-short' : 'duplicate'
    return { ok: false, reason, from, to }
  }

  const terrain = checkTerrain(world, a, b, options.halfWidth)
  if (terrain) return { ok: false, reason: terrain, from, to }

  const roads = checkRoadCrossings(graph, from.location, to.location, a, b)
  if (roads) return { ok: false, reason: roads, from, to }

  return { ok: true, from, to }
}

/**
 * Samples the road's footprint (centre line plus both edges) every 0.1 tiles
 * and rejects it if any sample is off the map or on impassable terrain.
 */
export function checkTerrain(
  world: World,
  a: Point,
  b: Point,
  halfWidth: number,
): 'off-map' | 'obstacle' | undefined {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  const nx = length > 0 ? -dy / length : 0
  const ny = length > 0 ? dx / length : 0
  const steps = Math.max(1, Math.ceil(length / 0.1))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    for (const w of [-halfWidth, 0, halfWidth]) {
      const x = a.x + dx * t + nx * w
      const y = a.y + dy * t + ny * w
      const terrain = terrainAt(world, { tx: Math.floor(x), ty: Math.floor(y) })
      if (terrain === undefined) return 'off-map'
      if (!isPassable(terrain)) return 'obstacle'
    }
  }
  return undefined
}

/**
 * Rejects a road that crosses an existing edge anywhere other than at its own
 * endpoints, or that runs along an edge it starts or ends on.
 */
export function checkRoadCrossings(
  graph: RoadGraph,
  from: RoadLocation,
  to: RoadLocation,
  a: Point,
  b: Point,
): 'crosses-road' | 'duplicate' | undefined {
  const touching = new Set<number>([...edgesAt(graph, from), ...edgesAt(graph, to)])
  for (const edge of graph.edges()) {
    const p = graph.getNode(edge.a)!.position
    const q = graph.getNode(edge.b)!.position
    if (touching.has(edge.id)) {
      if (overlaps(a, b, p, q)) return 'duplicate'
      continue
    }
    if (segmentsIntersect(a, b, p, q)) return 'crosses-road'
  }
  return undefined
}

function edgesAt(graph: RoadGraph, location: RoadLocation): number[] {
  if (location.kind === 'edge') return [location.edge]
  return graph.edgesAt(location.node).map((e: RoadEdge) => e.id)
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx
}

/** True if segment ab touches segment pq at any point except a or b. */
export function segmentsIntersect(a: Point, b: Point, p: Point, q: Point): boolean {
  const rx = b.x - a.x
  const ry = b.y - a.y
  const sx = q.x - p.x
  const sy = q.y - p.y
  const denom = cross(rx, ry, sx, sy)
  const qpx = p.x - a.x
  const qpy = p.y - a.y
  const eps = 1e-9
  if (Math.abs(denom) < eps) {
    // Parallel: only a problem if collinear and overlapping in ab's interior.
    if (Math.abs(cross(qpx, qpy, rx, ry)) > eps) return false
    return overlaps(a, b, p, q)
  }
  const t = cross(qpx, qpy, sx, sy) / denom
  const u = cross(qpx, qpy, rx, ry) / denom
  const lenAb = Math.hypot(rx, ry)
  const tol = EPSILON / Math.max(lenAb, EPSILON) + 1e-6
  return t > tol && t < 1 - tol && u >= -1e-9 && u <= 1 + 1e-9
}

/** True if collinear segments ab and pq share more than a single point. */
function overlaps(a: Point, b: Point, p: Point, q: Point): boolean {
  const rx = b.x - a.x
  const ry = b.y - a.y
  const len2 = rx * rx + ry * ry
  if (len2 === 0) return false
  // Not collinear: both p and q must lie on the line through ab.
  const offP = cross(p.x - a.x, p.y - a.y, rx, ry) / Math.sqrt(len2)
  const offQ = cross(q.x - a.x, q.y - a.y, rx, ry) / Math.sqrt(len2)
  if (Math.abs(offP) > 1e-6 || Math.abs(offQ) > 1e-6) return false
  const tp = ((p.x - a.x) * rx + (p.y - a.y) * ry) / len2
  const tq = ((q.x - a.x) * rx + (q.y - a.y) * ry) / len2
  const lo = Math.max(0, Math.min(tp, tq))
  const hi = Math.min(1, Math.max(tp, tq))
  return hi - lo > 1e-6
}
