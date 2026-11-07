import type { PlayerRoad } from '../session/roadEditor'
import { roadWidth, ROAD_GEOMETRY } from '../sim/lanes'
import { worldToScreen, type Viewport } from '../world/viewport'
import type { RenderContext } from './renderWorld'
import { COLORS } from './palette'

/**
 * Overlays for road editing (#33): closing roads get red-and-white barrier
 * stripes along their length (not colour alone: the dashes are the cue), and
 * the road selected for removal gets a bright outline.
 */
export function renderRoadEdits(ctx: RenderContext, roads: readonly PlayerRoad[], v: Viewport, selected?: number): void {
  const s = v.scale
  const width = roadWidth(ROAD_GEOMETRY) * s
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const road of roads) {
    const isSelected = road.id === selected && road.state === 'open'
    if (road.state !== 'closing' && !isSelected) continue
    trace(ctx, road, v)
    if (isSelected) {
      // A translucent band over the road keeps its markings visible.
      ctx.setLineDash([])
      ctx.strokeStyle = COLORS.editSelected
      ctx.lineWidth = width + Math.max(6, s * 0.3)
      ctx.stroke()
      continue
    }
    ctx.lineWidth = Math.max(3, width * 0.45)
    ctx.setLineDash([])
    ctx.strokeStyle = COLORS.editClosingLight
    ctx.stroke()
    ctx.setLineDash([Math.max(4, s * 0.3), Math.max(4, s * 0.3)])
    ctx.strokeStyle = COLORS.editClosing
    trace(ctx, road, v)
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.restore()
}

function trace(ctx: RenderContext, road: PlayerRoad, v: Viewport): void {
  ctx.beginPath()
  road.points.forEach((point, i) => {
    const p = worldToScreen(v, point)
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  })
}
