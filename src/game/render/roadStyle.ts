import type { Point } from '../world/types'
import { worldToScreen, type Viewport } from '../world/viewport'
import type { RenderContext } from './renderWorld'
import { roadWidth, ROAD_GEOMETRY } from '../sim/lanes'
import { COLORS } from './palette'

/**
 * Road drawing widths in tiles, derived from the shared two-lane geometry
 * (#22) so generated and player-built roads look identical and always fit
 * two lanes of traffic.
 */
export const ROAD_SURFACE_WIDTH = roadWidth(ROAD_GEOMETRY)
/** Surface plus a thin verge on each side. */
export const ROAD_EDGE_WIDTH = ROAD_SURFACE_WIDTH + 0.12
/** Dashed centre line separating the two lanes. */
export const CENTRE_LINE_WIDTH = 0.04

/** Shadow offset under roads, in CSS pixels (down-right, like the rest of the map). */
const SHADOW = 1.5
/** Keep lane markings out of the shared footprint of a junction. */
const JUNCTION_MARKING_CLEARANCE = ROAD_SURFACE_WIDTH * 0.5

function traceAll(ctx: RenderContext, v: Viewport, lines: readonly (readonly Point[])[], dx = 0, dy = 0): void {
  ctx.beginPath()
  for (const points of lines) {
    if (points.length < 2) continue
    points.forEach((point, k) => {
      const q = worldToScreen(v, point)
      if (k === 0) ctx.moveTo(q.x + dx, q.y + dy)
      else ctx.lineTo(q.x + dx, q.y + dy)
    })
  }
  // One stroke per style pass keeps intersecting road surfaces composited
  // together instead of repeatedly painting overlapping end caps.
  ctx.stroke()
}

const JUNCTION_EPSILON = 1e-6
const JUNCTION_MERGE_DISTANCE = 0.02

function addJunction(points: Point[], point: Point): void {
  if (!points.some((existing) => Math.hypot(existing.x - point.x, existing.y - point.y) < JUNCTION_MERGE_DISTANCE)) {
    points.push(point)
  }
}

/** Intersection of two finite segments, including a single shared collinear endpoint. */
function segmentJunction(p: Point, q: Point, r: Point, s: Point): Point | undefined {
  const rx = q.x - p.x
  const ry = q.y - p.y
  const sx = s.x - r.x
  const sy = s.y - r.y
  const denominator = rx * sy - ry * sx
  const qpx = r.x - p.x
  const qpy = r.y - p.y

  if (Math.abs(denominator) <= 1e-9 * Math.max(1, Math.hypot(rx, ry) * Math.hypot(sx, sy))) {
    const lengthSq = rx * rx + ry * ry
    if (lengthSq <= JUNCTION_EPSILON * JUNCTION_EPSILON) return undefined
    // Parallel segments only meet at a junction when their collinear overlap
    // collapses to one point. A shared stretch is duplicate road, not a node.
    if (Math.abs(qpx * ry - qpy * rx) > JUNCTION_EPSILON * Math.max(1, Math.hypot(rx, ry))) return undefined
    const t0 = (qpx * rx + qpy * ry) / lengthSq
    const t1 = ((s.x - p.x) * rx + (s.y - p.y) * ry) / lengthSq
    const overlapStart = Math.max(0, Math.min(t0, t1))
    const overlapEnd = Math.min(1, Math.max(t0, t1))
    if (overlapEnd < overlapStart - JUNCTION_EPSILON || overlapEnd - overlapStart > JUNCTION_EPSILON) return undefined
    const t = Math.max(0, Math.min(1, (overlapStart + overlapEnd) / 2))
    return { x: p.x + t * rx, y: p.y + t * ry }
  }

  const t = (qpx * sy - qpy * sx) / denominator
  const u = (qpx * ry - qpy * rx) / denominator
  if (t < -JUNCTION_EPSILON || t > 1 + JUNCTION_EPSILON || u < -JUNCTION_EPSILON || u > 1 + JUNCTION_EPSILON) return undefined
  const clamped = Math.max(0, Math.min(1, t))
  return { x: p.x + clamped * rx, y: p.y + clamped * ry }
}

/** Intersections between one candidate road and existing road polylines. */
export function findRoadIntersections(
  candidate: readonly Point[],
  existing: readonly (readonly Point[])[],
): Point[] {
  const intersections: Point[] = []
  if (candidate.length < 2) return intersections
  for (const line of existing) {
    if (line.length < 2 || line === candidate) continue
    for (let i = 1; i < candidate.length; i++) {
      const p = candidate[i - 1]!
      const q = candidate[i]!
      for (let j = 1; j < line.length; j++) {
        const point = segmentJunction(p, q, line[j - 1]!, line[j]!)
        if (point) addJunction(intersections, point)
      }
    }
  }
  return intersections
}

/** Find unique junction centres between distinct road polylines. */
export function findRoadJunctions(lines: readonly (readonly Point[])[]): Point[] {
  const junctions: Point[] = []
  for (let i = 0; i < lines.length; i++) {
    junctions.push(...findRoadIntersections(lines[i]!, lines.slice(i + 1)))
  }
  const unique: Point[] = []
  for (const point of junctions) addJunction(unique, point)
  return unique
}

/**
 * Strokes road polylines in the shared style: soft drop shadow, dark kerb,
 * asphalt and (when zoomed in enough) a dashed centre line. Generated and
 * player-built roads both use this so they always match.
 */
export function strokeRoads(ctx: RenderContext, v: Viewport, lines: readonly (readonly Point[])[]): void {
  const s = v.scale
  const drawn = lines.filter((points) => points.length >= 2)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const passes: [string, number, number][] = [
    [COLORS.roadShadow, ROAD_EDGE_WIDTH + 0.04, SHADOW],
    [COLORS.roadEdge, ROAD_EDGE_WIDTH, 0],
    [COLORS.road, ROAD_SURFACE_WIDTH, 0],
  ]
  for (const [color, width, offset] of passes) {
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(2, s * width)
    traceAll(ctx, v, drawn, offset, offset)
  }

  // Give every shared intersection one continuous footprint. Painting the
  // kerb and asphalt discs after the road strokes hides overlapping end caps
  // and seams while preserving the same width as the adjoining road.
  for (const junction of junctions) {
    const p = worldToScreen(v, junction)
    ctx.fillStyle = COLORS.roadEdge
    ctx.beginPath()
    ctx.arc(p.x, p.y, Math.max(1, s * ROAD_EDGE_WIDTH * 0.5), 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = COLORS.road
    ctx.beginPath()
    ctx.arc(p.x, p.y, Math.max(1, s * ROAD_SURFACE_WIDTH * 0.5), 0, Math.PI * 2)
    ctx.fill()
  }

  if (s >= 10) {
    ctx.strokeStyle = COLORS.roadMarking
    ctx.lineWidth = Math.max(1, s * CENTRE_LINE_WIDTH)
    ctx.setLineDash([s * 0.25, s * 0.25])
    traceAll(ctx, v, drawn)
    ctx.setLineDash([])
    // Keep lane markings out of the shared centre of each junction.
    ctx.fillStyle = COLORS.road
    for (const junction of findJunctions(drawn)) {
      const p = worldToScreen(v, junction)
      ctx.beginPath()
      ctx.arc(p.x, p.y, s * JUNCTION_MARKING_CLEARANCE, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
