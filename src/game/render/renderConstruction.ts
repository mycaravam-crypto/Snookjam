import type { BuiltRoad, ConstructionPreview } from '../build/controller'
import type { Point } from '../roads/graph'
import { worldToScreen, type Viewport } from '../world/viewport'
import type { RenderContext } from './renderWorld'
import { COLORS } from './palette'
import { findRoadIntersections, ROAD_EDGE_WIDTH, ROAD_SURFACE_WIDTH, strokeRoads } from './roadStyle'

export type ConstructionContext = RenderContext & Pick<CanvasRenderingContext2D, 'globalAlpha'>

/** Player-built roads, drawn in the same style as generated roads. */
export function renderBuiltRoads(ctx: ConstructionContext, roads: readonly BuiltRoad[], v: Viewport): void {
  ctx.save()
  strokeRoads(ctx, v, roads.map(roadPoints))
  ctx.restore()
}

export type ConstructionFeedback = {
  readonly kind: 'committed' | 'rejected'
  readonly from: Point
  readonly to: Point
  /** Road polyline; defaults to the straight line from `from` to `to`. */
  readonly points?: readonly Point[]
}

/**
 * Draws the drag preview along the smoothed freehand path: solid green with
 * round end caps when valid, dashed red with a cross at the end when invalid
 * (shape differs, not just colour). While the end is within snapping range a
 * ring marks the snapped connection point and a thin tether joins it to the
 * pointer, so the player can see where the road will attach before releasing.
 * Also draws a short-lived committed/rejected flash.
 */
export function renderConstructionPreview(
  ctx: ConstructionContext,
  preview: ConstructionPreview | undefined,
  feedback: ConstructionFeedback | undefined,
  v: Viewport,
  junctionRoads: readonly (readonly Point[])[] = [],
): void {
  const s = v.scale
  ctx.save()
  ctx.lineCap = 'round'
  if (feedback) {
    ctx.globalAlpha = 0.85
    const feedbackPoints = roadPoints(feedback)
    ctx.strokeStyle = COLORS.buildOutline
    ctx.lineWidth = Math.max(2, s * ROAD_EDGE_WIDTH)
    polyline(ctx, v, feedbackPoints)
    ctx.strokeStyle = feedback.kind === 'committed' ? COLORS.buildValid : COLORS.buildInvalid
    ctx.lineWidth = Math.max(2, s * ROAD_SURFACE_WIDTH)
    polyline(ctx, v, feedbackPoints)
    ctx.globalAlpha = 1
  }
  if (preview) {
    const valid = preview.check.ok
    const points = preview.path.length >= 2 ? preview.path : [preview.from, preview.to]
    // Match the finished two-lane road footprint, rather than showing a
    // narrow guide line that grows into a much wider road on release.
    ctx.strokeStyle = COLORS.buildOutline
    ctx.lineWidth = Math.max(2, s * ROAD_EDGE_WIDTH)
    polyline(ctx, v, points)
    ctx.strokeStyle = valid ? COLORS.buildValid : COLORS.buildInvalid
    ctx.lineWidth = Math.max(2, s * ROAD_SURFACE_WIDTH)
    if (!valid) ctx.setLineDash([s * 0.4, s * 0.3])
    polyline(ctx, v, points)
    ctx.setLineDash([])
    drawPreviewJunctions(ctx, v, points, junctionRoads, valid ? COLORS.buildValid : COLORS.buildInvalid)
    if (preview.endSnap) snapIndicator(ctx, v, preview.pointer, preview.endSnap.position, preview.endSnap.location.kind === 'node')
    endpoint(ctx, v, preview.from, true)
    endpoint(ctx, v, preview.to, valid)
  }
  ctx.restore()
}

function roadPoints(road: { from: Point; to: Point; points?: readonly Point[] }): readonly Point[] {
  return road.points && road.points.length >= 2 ? road.points : [road.from, road.to]
}

function polyline(ctx: RenderContext, v: Viewport, points: readonly Point[]): void {
  if (points.length < 2) return
  ctx.beginPath()
  points.forEach((point, i) => {
    const p = worldToScreen(v, point)
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  })
  ctx.stroke()
}

/**
 * Snap feedback: a ring around the connection point (square for a junction or
 * road end, circle for a point along a road) and a thin tether to the pointer.
 */
function snapIndicator(ctx: RenderContext, v: Viewport, pointer: Point, at: Point, node: boolean): void {
  const p = worldToScreen(v, at)
  const r = Math.max(9, v.scale * 0.8)
  ctx.strokeStyle = COLORS.buildOutline
  ctx.lineWidth = 1.5
  polyline(ctx, v, [pointer, at])
  ctx.lineWidth = Math.max(2, v.scale * 0.12)
  ctx.beginPath()
  if (node) {
    ctx.moveTo(p.x - r, p.y - r)
    ctx.lineTo(p.x + r, p.y - r)
    ctx.lineTo(p.x + r, p.y + r)
    ctx.lineTo(p.x - r, p.y + r)
    ctx.lineTo(p.x - r, p.y - r)
  } else {
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
  }
  ctx.stroke()
}

function endpoint(ctx: RenderContext, v: Viewport, at: Point, ok: boolean): void {
  const p = worldToScreen(v, at)
  const r = Math.max(4, v.scale * 0.35)
  ctx.fillStyle = COLORS.buildOutline
  ctx.beginPath()
  ctx.arc(p.x, p.y, r + 2, 0, Math.PI * 2)
  ctx.fill()
  if (ok) {
    ctx.fillStyle = COLORS.buildValid
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.strokeStyle = COLORS.buildInvalid
    ctx.lineWidth = Math.max(2, r * 0.45)
    ctx.beginPath()
    ctx.moveTo(p.x - r * 0.7, p.y - r * 0.7)
    ctx.lineTo(p.x + r * 0.7, p.y + r * 0.7)
    ctx.moveTo(p.x + r * 0.7, p.y - r * 0.7)
    ctx.lineTo(p.x - r * 0.7, p.y + r * 0.7)
    ctx.stroke()
  }
}

/** Paint the same shared road footprint in the live preview as on commit. */
function drawPreviewJunctions(
  ctx: RenderContext,
  v: Viewport,
  candidate: readonly Point[],
  existing: readonly (readonly Point[])[],
  surface: string,
): void {
  for (const junction of findRoadIntersections(candidate, existing)) {
    const p = worldToScreen(v, junction)
    ctx.fillStyle = COLORS.buildOutline
    ctx.beginPath()
    ctx.arc(p.x, p.y, Math.max(1, v.scale * ROAD_EDGE_WIDTH * 0.5), 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = surface
    ctx.beginPath()
    ctx.arc(p.x, p.y, Math.max(1, v.scale * ROAD_SURFACE_WIDTH * 0.5), 0, Math.PI * 2)
    ctx.fill()
  }
}
