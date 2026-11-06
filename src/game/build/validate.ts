import { EPSILON, type NearestLocation, type Point, type RoadEdge, type RoadGraph, type RoadLocation } from '../roads/graph'
import { isPassable, terrainAt, type World } from '../world/types'
import { buildRoadPath, DEFAULT_PATH_OPTIONS, pathLength, pointSegmentDistance, type PathOptions } from './path'

/**
 * Snap tolerance in tiles (#18). Deliberately generous: at the smallest
 * playable zoom a tile is ~16 CSS px, so 1.25 tiles is ~20 px either side of a
 * road, about the size of a fingertip contact and well beyond mouse jitter,
 * while still less than the ~2-tile gap between parallel generated roads.
 */
export const DEFAULT_SNAP_DISTANCE = 1.25

export interface ConstructionOptions extends PathOptions {
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
  /**
   * Bends of a freehand road must stay at least this far (tiles) from other
   * roads, so a road drawn alongside an existing one is not built on top of it.
   */
  readonly clearance: number
}

export const DEFAULT_CONSTRUCTION_OPTIONS: ConstructionOptions = Object.freeze({
  ...DEFAULT_PATH_OPTIONS,
  snapDistance: DEFAULT_SNAP_DISTANCE,
  nodeSnap: 0.5,
  minLength: 1,
  maxLength: Infinity,
  halfWidth: 0.2,
  clearance: 0.5,
})

/** Defaults with selected overrides, e.g. a larger snap distance for touch. */
export function constructionOptions(overrides: Partial<ConstructionOptions> = {}): ConstructionOptions {
  const options = { ...DEFAULT_CONSTRUCTION_OPTIONS, ...overrides }
  if (!(options.snapDistance > 0) || !Number.isFinite(options.snapDistance)) {
    throw new RangeError('snapDistance must be a positive number')
  }
  if (options.nodeSnap < 0 || !(options.minSegmentLength > 0) || options.sampleSpacing < 0 || !(options.resampleSpacing > 0)) {
    throw new RangeError('invalid construction options')
  }
  return Object.freeze(options)
}

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
  | 'self-crossing'
  | 'build-failed'

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
  'too-close': 'Keep new roads clear of existing ones',
  'self-crossing': 'A road cannot cross itself',
  'build-failed': 'Roads cannot be built right now',
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

/** A connection check for a freehand path, with the road geometry it would build. */
export type PathCheck = ConnectionCheck & {
  /**
   * Smoothed road polyline from the snapped start to the snapped end (or to
   * the raw pointer when the end is not on a road). Empty when the start is
   * not on a road.
   */
  readonly path: readonly Point[]
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
 * Validates a straight road from `start` to `end` (world points, unsnapped).
 * Both ends must snap to the existing network; the road between the snapped
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
  const { path: _path, ...check } = checkPath(world, graph, start, end, [], options)
  return check as ConnectionCheck
}

/**
 * Validates a freehand road (#18). `samples` is the captured pointer
 * trajectory between `start` and `end`; it is smoothed and simplified into a
 * polyline whose ends are snapped to the network. Every segment is checked
 * against terrain and existing roads, bends must keep `clearance` from other
 * roads, and the road may not cross itself. Never mutates the graph.
 */
export function checkPath(
  world: World,
  graph: RoadGraph,
  start: Point,
  end: Point,
  samples: readonly Point[],
  options: ConstructionOptions = DEFAULT_CONSTRUCTION_OPTIONS,
): PathCheck {
  const from = snapToRoad(graph, start, options)
  if (!from) return { ok: false, reason: 'not-on-road', path: [] }
  const to = snapToRoad(graph, end, options)
  const path = buildRoadPath(from.position, to?.position ?? end, samples, options)
  if (!to) return { ok: false, reason: 'not-connected', from, path }
  const fail = (reason: RejectionReason): PathCheck => ({ ok: false, reason, from, to, path })

  const length = pathLength(path)
  if (length < options.minLength) return fail('too-short')
  if (length > options.maxLength) return fail('too-long')

  const via = path.slice(1, -1)
  const graphCheck = graph.canConnect(from.location, to.location, via)
  if (!graphCheck.ok) return fail(graphCheck.reason === 'zero-length' ? 'too-short' : 'duplicate')

  for (let i = 1; i < path.length; i++) {
    const terrain = checkTerrain(world, path[i - 1]!, path[i]!, options.halfWidth)
    if (terrain) return fail(terrain)
  }

  const selfCrossing = checkSelfCrossing(path)
  if (selfCrossing) return fail(selfCrossing)

  const roads = checkPathCrossings(graph, from.location, to.location, path, options.clearance)
  if (roads) return fail(roads)

  return { ok: true, from, to, path }
}

/**
 * Rejects a polyline whose non-adjacent segments touch, or which doubles back
 * on itself between adjacent segments.
 */
export function checkSelfCrossing(path: readonly Point[]): 'self-crossing' | undefined {
  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    const c = path[i + 1]!
    const ux = b.x - a.x
    const uy = b.y - a.y
    const vx = c.x - b.x
    const vy = c.y - b.y
    const dot = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))
    if (dot < -0.999) return 'self-crossing'
  }
  for (let i = 1; i < path.length; i++) {
    for (let j = i + 2; j < path.length; j++) {
      const a = path[i - 1]!
      const b = path[i]!
      const p = path[j - 1]!
      const q = path[j]!
      if (segmentsIntersect(a, b, p, q) || segmentsIntersect(p, q, a, b)) return 'self-crossing'
    }
  }
  return undefined
}

/**
 * Checks each segment of `path` against the existing network. The first
 * segment may meet the roads at `from`, the last those at `to`; no segment may
 * otherwise cross a road, and interior bends must keep `clearance` from all
 * roads.
 */
export function checkPathCrossings(
  graph: RoadGraph,
  from: RoadLocation,
  to: RoadLocation,
  path: readonly Point[],
  clearance: number,
): 'crosses-road' | 'duplicate' | 'too-close' | undefined {
  const last = path.length - 1
  for (let i = 1; i <= last; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    if (path.length === 2) return checkRoadCrossings(graph, from, to, a, b)
    const touching = new Set<number>([...(i === 1 ? edgesAt(graph, from) : []), ...(i === last ? edgesAt(graph, to) : [])])
    for (const edge of graph.edges()) {
      const p = graph.getNode(edge.a)!.position
      const q = graph.getNode(edge.b)!.position
      if (touching.has(edge.id)) {
        if (overlaps(a, b, p, q)) return 'duplicate'
        // The segment's far end is a bend, which must not sit on this road.
        const bend = i === 1 ? b : a
        if (pointSegmentDistance(bend, p, q) < EPSILON) return 'crosses-road'
        continue
      }
      if (segmentsIntersect(a, b, p, q) || segmentsIntersect(p, q, a, b)) return 'crosses-road'
    }
  }
  for (let i = 1; i < last; i++) {
    const bend = path[i]!
    for (const edge of graph.edges()) {
      const p = graph.getNode(edge.a)!.position
      const q = graph.getNode(edge.b)!.position
      if (pointSegmentDistance(bend, p, q) < clearance) return 'too-close'
    }
  }
  return undefined
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
