import { EPSILON, type NearestLocation, type Point, type RoadEdge, type RoadGraph, type RoadLocation } from '../roads/graph'
import { isPassable, terrainAt, type World } from '../world/types'
import { roadWidth } from '../sim/lanes'
import { buildRoadPath, DEFAULT_PATH_OPTIONS, pathLength, pointSegmentDistance, type PathOptions } from './path'

/**
 * Start acquisition remains conservative so a drag begins on the road the
 * player intended. The release end uses a wider radius to make connections
 * forgiving, especially on touch screens.
 */
export const DEFAULT_SNAP_DISTANCE = 1.25

export interface ConstructionOptions extends PathOptions {
  /** Start acquisition radius (tiles). */
  readonly snapDistance: number
  /** Release-end radius (tiles); wider to make connections forgiving. */
  readonly endSnapDistance: number
  /**
   * Once the end has snapped to a road, it stays on that road until the
   * pointer is this far (tiles) from it, so jitter near competing roads does
   * not make the preview jump. Must be at least `endSnapDistance`.
   */
  readonly endSnapRelease: number
  /** Within this distance (tiles) of a node, snap to the node itself. */
  readonly nodeSnap: number
  /** Shortest road the player may build, in tiles. */
  readonly minLength: number
  /** Longest road the player may build, in tiles (Infinity = no limit). */
  readonly maxLength: number
  /** Half the road width, used when checking terrain under the road. */
  readonly halfWidth: number
  /**
   * Minimum distance (tiles) between the new road's centre line (segments
   * and freehand bends) and any road it does not join, so two-lane road
   * surfaces never overlap (#22).
   */
  readonly clearance: number
  /** Minimum angle (radians) between the new road and a road it joins (#22); 0 disables the check. */
  readonly minJoinAngle: number
}

export const DEFAULT_CONSTRUCTION_OPTIONS: ConstructionOptions = Object.freeze({
  ...DEFAULT_PATH_OPTIONS,
  snapDistance: DEFAULT_SNAP_DISTANCE,
  endSnapDistance: 2.75,
  endSnapRelease: 3.5,
  nodeSnap: 0.5,
  minLength: 1,
  maxLength: Infinity,
  halfWidth: roadWidth() / 2,
  clearance: roadWidth(),
  // No minimum: players may join roads at any angle, realistic or not.
  minJoinAngle: 0,
})

/** Defaults with selected overrides, e.g. a larger snap distance for touch. */
export function constructionOptions(overrides: Partial<ConstructionOptions> = {}): ConstructionOptions {
  const options = { ...DEFAULT_CONSTRUCTION_OPTIONS, ...overrides }
  if (!(options.snapDistance > 0) || !Number.isFinite(options.snapDistance)) {
    throw new RangeError('snapDistance must be a positive number')
  }
  if (!(options.endSnapDistance > 0) || !Number.isFinite(options.endSnapDistance)) {
    throw new RangeError('endSnapDistance must be a positive number')
  }
  if (!(options.endSnapRelease >= options.endSnapDistance) || !Number.isFinite(options.endSnapRelease)) {
    throw new RangeError('endSnapRelease must be a finite number of at least endSnapDistance')
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
  | 'too-sharp'
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
  'too-sharp': 'Roads must meet at a wider angle',
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
export type PathCheck =
  | { readonly ok: true; readonly from: NearestLocation; readonly to?: NearestLocation; readonly path: readonly Point[] }
  | {
      readonly ok: false
      readonly reason: RejectionReason
      readonly from?: NearestLocation
      readonly to?: NearestLocation
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
 * Snaps the release end: to the latched road while within `endSnapRelease`,
 * otherwise to the nearest road within `endSnapDistance`.
 */
export function snapEnd(
  graph: RoadGraph,
  point: Point,
  options: ConstructionOptions = DEFAULT_CONSTRUCTION_OPTIONS,
  latch?: RoadLocation,
): NearestLocation | undefined {
  const latched = latch && graph.nearestLocationOn(latch, point, options.endSnapRelease, options.nodeSnap)
  return latched || graph.nearestLocation(point, options.endSnapDistance, options.nodeSnap)
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
  if (check.ok && !check.to) return { ok: false, reason: 'not-connected', from: check.from }
  return check as ConnectionCheck
}

/**
 * Validates a freehand road (#18). `samples` is the captured pointer
 * trajectory between `start` and `end`; it is smoothed and simplified into a
 * polyline whose ends are snapped to the network. Every segment is checked
 * against terrain and existing roads, bends must keep `clearance` from other
 * roads, and the road may not cross itself. Never mutates the graph.
 *
 * `endLatch` is where the end snapped on the previous preview of the same
 * gesture: while the pointer stays within `endSnapRelease` of that road, the
 * end keeps snapping to it (hysteresis).
 */
export function checkPath(
  world: World,
  graph: RoadGraph,
  start: Point,
  end: Point,
  samples: readonly Point[],
  options: ConstructionOptions = DEFAULT_CONSTRUCTION_OPTIONS,
  endLatch?: RoadLocation,
): PathCheck {
  const from = snapToRoad(graph, start, options)
  if (!from) return { ok: false, reason: 'not-on-road', path: [] }
  const to = snapEnd(graph, end, options, endLatch)
  const path = buildRoadPath(from.position, to?.position ?? end, samples, options)
  const fail = (reason: RejectionReason): PathCheck => ({ ok: false, reason, from, ...(to ? { to } : {}), path })

  const length = pathLength(path)
  if (length < options.minLength) return fail('too-short')
  if (length > options.maxLength) return fail('too-long')

  const via = path.slice(1, -1)
  if (to) {
    const graphCheck = graph.canConnect(from.location, to.location, via)
    if (!graphCheck.ok) return fail(graphCheck.reason === 'zero-length' ? 'too-short' : 'duplicate')
  }

  for (let i = 1; i < path.length; i++) {
    const terrain = checkTerrain(world, path[i - 1]!, path[i]!, options.halfWidth)
    if (terrain) return fail(terrain)
  }

  const selfCrossing = checkSelfCrossing(path)
  if (selfCrossing) return fail(selfCrossing)

  const roads = checkPathCrossings(graph, from.location, to?.location, path, options.clearance)
  if (roads) return fail(roads)

  const spacing = checkRoadSpacing(graph, from.location, to?.location, path, options)
  if (spacing) return fail(spacing)

  return { ok: true, from, ...(to ? { to } : {}), path }
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
  to: RoadLocation | undefined,
  path: readonly Point[],
  clearance: number,
): 'crosses-road' | 'duplicate' | 'too-close' | undefined {
  const last = path.length - 1
  if (path.length === 2 && to) return checkRoadCrossings(graph, from, to, path[0]!, path[1]!)
  for (let i = 1; i <= last; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    const touching = new Set<number>([...(i === 1 ? edgesAt(graph, from) : []), ...(i === last && to ? edgesAt(graph, to) : [])])
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
      // Proper crossings become graph junctions when the road is committed.
      if (overlaps(a, b, p, q)) return 'duplicate'
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
    // A proper crossing is now a supported junction; overlapping geometry is not.
    if (overlaps(a, b, p, q)) return 'duplicate'
  }
  return undefined
}

function edgesAt(graph: RoadGraph, location: RoadLocation | undefined): number[] {
  if (!location) return []
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
 * Two-lane roads need room (#22). The new road's first and last segments
 * must meet the roads they join at `minJoinAngle` or more (off by default),
 * and every segment must stay at least `clearance` from roads it does not
 * join. Near its own ends (within `clearance` along the path) a segment may
 * of course approach the roads it joins there; consecutive segments of the
 * new road are never checked against each other.
 */
export function checkRoadSpacing(
  graph: RoadGraph,
  from: RoadLocation,
  to: RoadLocation | undefined,
  path: readonly Point[],
  options: ConstructionOptions = DEFAULT_CONSTRUCTION_OPTIONS,
): 'too-close' | 'too-sharp' | undefined {
  if (path.length < 2) return undefined
  const last = path.length - 1
  const startEdges = edgesAt(graph, from)
  const endEdges = to ? edgesAt(graph, to) : []

  if (options.minJoinAngle > 0) for (const [edges, at, next] of [
    [startEdges, path[0]!, path[1]!],
    [endEdges, path[last]!, path[last - 1]!],
  ] as const) {
    const out = unit(at, next)
    for (const id of edges) {
      const e = graph.getEdge(id)!
      for (const end of [e.a, e.b]) {
        const p = graph.getNode(end)!.position
        if (Math.hypot(p.x - at.x, p.y - at.y) < EPSILON) continue
        const along = unit(at, p)
        const angle = Math.acos(Math.max(-1, Math.min(1, along.x * out.x + along.y * out.y)))
        if (angle < options.minJoinAngle - 1e-9) return 'too-sharp'
      }
    }
  }

  // Path distance from the start to each vertex, to know which segments are
  // still close to the joins at either end.
  const along = [0]
  for (let i = 1; i <= last; i++) along.push(along[i - 1]! + Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y))
  const total = along[last]!
  for (let i = 1; i <= last; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    const skip = new Set<number>([
      ...(along[i - 1]! < options.clearance ? startEdges : []),
      ...(total - along[i]! < options.clearance ? endEdges : []),
    ])
    for (const edge of graph.edges()) {
      if (skip.has(edge.id)) continue
      const p = graph.getNode(edge.a)!.position
      const q = graph.getNode(edge.b)!.position
      if (segmentsIntersect(a, b, p, q) || segmentsIntersect(p, q, a, b)) continue
      if (segmentDistance(a, b, p, q) < options.clearance - 1e-9) return 'too-close'
    }
  }
  return undefined
}

function unit(from: Point, to: Point): Point {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return { x: (to.x - from.x) / len, y: (to.y - from.y) / len }
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
