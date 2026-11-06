import type { BuiltRoad, ConstructionPreview } from '../build/controller'
import type { Point } from '../roads/graph'
import { worldToScreen, type Viewport } from '../world/viewport'
import type { RenderContext } from './renderWorld'
import { CENTRE_LINE_WIDTH, ROAD_EDGE_WIDTH, ROAD_SURFACE_WIDTH } from './roadStyle'
import { COLORS } from './palette'

export type ConstructionContext = RenderContext & Pick<CanvasRenderingContext2D, 'globalAlpha'>

/** Player-built roads, drawn in the same style as generated roads. */
export function renderBuiltRoads(ctx: ConstructionContext, roads: readonly BuiltRoad[], v: Viewport): void {
  const s = v.scale
  ctx.save()
  ctx.lineCap = 'round'
  for (const [color, width] of [
    [COLORS.roadEdge, ROAD_EDGE_WIDTH],
    [COLORS.road, ROAD_SURFACE_WIDTH],
  ] as const) {
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(2, s * width)
    for (const road of roads) line(ctx, v, road.from, road.to)
  }
  if (s >= 10) {
    ctx.strokeStyle = COLORS.roadMarking
    ctx.lineWidth = Math.max(1, s * CENTRE_LINE_WIDTH)
    ctx.setLineDash([s * 0.25, s * 0.25])
    for (const road of roads) line(ctx, v, road.from, road.to)
    ctx.setLineDash([])
  }
  ctx.restore()
}

export type ConstructionFeedback =
  | { readonly kind: 'committed'; readonly from: Point; readonly to: Point }
  | { readonly kind: 'rejected'; readonly from: Point; readonly to: Point }

/**
 * Draws the drag preview: solid green with round end caps when valid, dashed
 * red with a cross at the end when invalid (shape differs, not just colour).
 * Also draws a short-lived committed/rejected flash.
 */
export function renderConstructionPreview(
  ctx: ConstructionContext,
  preview: ConstructionPreview | undefined,
  feedback: ConstructionFeedback | undefined,
  v: Viewport,
): void {
  const s = v.scale
  ctx.save()
  ctx.lineCap = 'round'
  if (feedback) {
    ctx.globalAlpha = 0.85
    ctx.strokeStyle = feedback.kind === 'committed' ? COLORS.buildValid : COLORS.buildInvalid
    ctx.lineWidth = Math.max(3, s * 0.75)
    line(ctx, v, feedback.from, feedback.to)
    ctx.globalAlpha = 1
  }
  if (preview) {
    const valid = preview.check.ok
    ctx.strokeStyle = COLORS.buildOutline
    ctx.lineWidth = Math.max(4, s * 0.6)
    line(ctx, v, preview.from, preview.to)
    ctx.strokeStyle = valid ? COLORS.buildValid : COLORS.buildInvalid
    ctx.lineWidth = Math.max(2, s * 0.4)
    if (!valid) ctx.setLineDash([s * 0.4, s * 0.3])
    line(ctx, v, preview.from, preview.to)
    ctx.setLineDash([])
    endpoint(ctx, v, preview.from, true)
    endpoint(ctx, v, preview.to, valid)
  }
  ctx.restore()
}

function line(ctx: RenderContext, v: Viewport, a: Point, b: Point): void {
  const p = worldToScreen(v, a)
  const q = worldToScreen(v, b)
  ctx.beginPath()
  ctx.moveTo(p.x, p.y)
  ctx.lineTo(q.x, q.y)
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
