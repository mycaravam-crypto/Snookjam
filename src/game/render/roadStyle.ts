import type { Point } from '../world/types'
import { worldToScreen, type Viewport } from '../world/viewport'
import type { RenderContext } from './renderWorld'
import { COLORS } from './palette'

/** Shadow offset under roads, in CSS pixels (down-right, like the rest of the map). */
const SHADOW = 1.5

function trace(ctx: RenderContext, v: Viewport, points: readonly Point[], dx = 0, dy = 0): void {
  ctx.beginPath()
  points.forEach((point, k) => {
    const q = worldToScreen(v, point)
    if (k === 0) ctx.moveTo(q.x + dx, q.y + dy)
    else ctx.lineTo(q.x + dx, q.y + dy)
  })
  ctx.stroke()
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
    [COLORS.roadShadow, 0.66, SHADOW],
    [COLORS.roadEdge, 0.62, 0],
    [COLORS.road, 0.48, 0],
  ]
  for (const [color, width, offset] of passes) {
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(2, s * width)
    for (const points of drawn) trace(ctx, v, points, offset, offset)
  }
  if (s >= 10) {
    ctx.strokeStyle = COLORS.roadMarking
    ctx.lineWidth = Math.max(1, s * 0.05)
    ctx.setLineDash([s * 0.25, s * 0.25])
    for (const points of drawn) trace(ctx, v, points)
    ctx.setLineDash([])
  }
}
