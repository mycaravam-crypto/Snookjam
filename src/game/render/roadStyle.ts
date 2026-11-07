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
/** Keep lane markings out of the shared centre of a junction. */
const JUNCTION_MARKING_CLEARANCE = ROAD_SURFACE_WIDTH * 0.3

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

/** Find intersections between distinct road polylines, including shared endpoints. */
function findJunctions(lines: readonly (readonly Point[])[]): Point[] {
  const junctions: Point[] = []
  for (let a = 0; a < lines.length; a++) {
    const first = lines[a]!
    for (let b = a + 1; b < lines.length; b++) {
      const second = lines[b]!
      for (let i = 1; i < first.length; i++) {
        const p = first[i - 1]!, q = first[i]!
        for (let j = 1; j < second.length; j++) {
          const r = second[j - 1]!, s = second[j]!
          const rx = q.x - p.x, ry = q.y - p.y
          const sx = s.x - r.x, sy = s.y - r.y
          const denominator = rx * sy - ry * sx
          if (Math.abs(denominator) < 1e-9) continue
          const t = ((r.x - p.x) * sy - (r.y - p.y) * sx) / denominator
          const u = ((r.x - p.x) * ry - (r.y - p.y) * rx) / denominator
          if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) continue
          const point = { x: p.x + t * rx, y: p.y + t * ry }
          if (!junctions.some((existing) => Math.hypot(existing.x - point.x, existing.y - point.y) < 0.02)) {
            junctions.push(point)
          }
        }
      }
    }
  }
  return junctions
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
  if (s >= 10) {
    ctx.strokeStyle = COLORS.roadMarking
    ctx.lineWidth = Math.max(1, s * CENTRE_LINE_WIDTH)
    ctx.setLineDash([s * 0.25, s * 0.25])
    traceAll(ctx, v, drawn)
    ctx.setLineDash([])
    // A small asphalt patch removes crossing centre dashes from the junction
    // itself. The road edge remains continuous around the outside footprint.
    ctx.fillStyle = COLORS.road
    for (const junction of findJunctions(drawn)) {
      const p = worldToScreen(v, junction)
      ctx.beginPath()
      ctx.arc(p.x, p.y, s * JUNCTION_MARKING_CLEARANCE, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
