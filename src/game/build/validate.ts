import { EPSILON, type NearestLocation, type Point, type RoadEdge, type RoadGraph, type RoadLocation } from '../roads/graph'
import { isPassable, terrainAt, type World } from '../world/types'
import { roadWidth } from '../sim/lanes'

export interface ConstructionOptions {
  /** How far (tiles) from a road a pointer may be and still snap to it. */
  readonly snapDistance: number
  /** Within this distance (tiles) of a node, snap to the node itself. */
  readonly nodeSnap: number
  /** Shortest road the player may build, in tiles. */
  readonly minLength: number
  /** Longest road the player may build, in tiles (Infinity = no limit). */
  readonly maxLength: number
  /** Half the road width, used when checking terrain under the road. */
  readonly halfWidth: number
  /**
   * Minimum distance (tiles) between the new road's centre line and any road
   * it does not join, so the two-lane surfaces never overlap (#22).
   */
  readonly clearance: number
  /** Minimum angle (radians) between the new road and a road it joins. */
  readonly minJoinAngle: number
}

export const DEFAULT_CONSTRUCTION_OPTIONS: ConstructionOptions = Object.freeze({
  snapDistance: 0.75,
  nodeSnap: 0.5,
  minLength: 1,
  maxLength: Infinity,
  halfWidth: roadWidth() / 2,
  clearance: roadWidth(),
  minJoinAngle: Math.PI / 3,
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
  | 'too-close'
  | 'too-sharp'

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
  'too-close': 'Too close to another road',
  'too-sharp': 'Roads must meet at a wider angle',
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

  const spacing = checkRoadSpacing(graph, from.location, to.location, a, b, options)
  if (spacing) return { ok: false, reason: spacing, from, to }

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

/**
 * Two-lane roads need room (#22): the new road must meet the roads it joins
 * at a reasonable angle, and stay at least `clearance` away from every other
 * road, so lanes of different roads never overlap.
 */
export function checkRoadSpacing(
  graph: RoadGraph,
  from: RoadLocation,
  to: RoadLocation,
  a: Point,
  b: Point,
  options: ConstructionOptions = DEFAULT_CONSTRUCTION_OPTIONS,
): 'too-close' | 'too-sharp' | undefined {
  const joined = new Set<number>()
  for (const [location, at, other] of [
    [from, a, b],
    [to, b, a],
  ] as const) {
    const out = unit(at, other)
    for (const edge of edgesAt(graph, location)) {
      joined.add(edge)
      // Directions along the joined road, away from the junction point.
      const e = graph.getEdge(edge)!
      for (const end of [e.a, e.b]) {
        const p = graph.getNode(end)!.position
        if (Math.hypot(p.x - at.x, p.y - at.y) < EPSILON) continue
        const along = unit(at, p)
        const angle = Math.acos(Math.max(-1, Math.min(1, along.x * out.x + along.y * out.y)))
        if (angle < options.minJoinAngle - 1e-9) return 'too-sharp'
      }
    }
  }
  for (const edge of graph.edges()) {
    if (joined.has(edge.id)) continue
    const p = graph.getNode(edge.a)!.position
    const q = graph.getNode(edge.b)!.position
    if (segmentDistance(a, b, p, q) < options.clearance - 1e-9) return 'too-close'
  }
  return undefined
}

function unit(from: Point, to: Point): Point {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return { x: (to.x - from.x) / len, y: (to.y - from.y) / len }
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/** Shortest distance between two segments (0 if they intersect). */
export function segmentDistance(a: Point, b: Point, p: Point, q: Point): number {
  if (segmentsIntersect(a, b, p, q) || segmentsIntersect(p, q, a, b)) return 0
  return Math.min(
    pointSegmentDistance(a, p, q),
    pointSegmentDistance(b, p, q),
    pointSegmentDistance(p, a, b),
    pointSegmentDistance(q, a, b),
  )
}
