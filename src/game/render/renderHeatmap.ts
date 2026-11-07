import type { NetworkMonitor } from '../diagnostics'
import type { RoadGraph } from '../roads'
import { ROAD_GEOMETRY } from '../sim/lanes'
import { worldToScreen, type Viewport } from '../world/viewport'
import { COLORS } from './palette'
import type { RenderContext } from './renderWorld'

/** Below this heat a road is not tinted. */
export const HEATMAP_MIN_HEAT = 0.04

/** Sequential heat scale: pale yellow (light queue) → orange → red (lane full). */
const HEAT_STOPS: readonly (readonly [number, readonly [number, number, number]])[] = [
  [0, [255, 224, 102]],
  [0.5, [245, 140, 20]],
  [1, [214, 40, 40]],
]

/** CSS colour for a heat value in [0, 1]; alpha grows with heat. */
export function heatColor(heat: number): string {
  const h = Math.min(1, Math.max(0, heat))
  let i = 1
  while (i < HEAT_STOPS.length - 1 && h > HEAT_STOPS[i]![0]) i++
  const [t0, c0] = HEAT_STOPS[i - 1]!
  const [t1, c1] = HEAT_STOPS[i]!
  const f = (h - t0) / (t1 - t0)
  const ch = (k: number) => Math.round(c0[k]! + (c1[k]! - c0[k]!) * f)
  const alpha = 0.35 + 0.5 * h
  return `rgba(${ch(0)}, ${ch(1)}, ${ch(2)}, ${alpha.toFixed(3)})`
}

/**
 * Draws the congestion overlay (#34) from a NetworkMonitor: each road with a
 * queue is tinted by its heat, persistent bottlenecks get a dashed white
 * border, and blocked junctions a red ring with a white "×", so the three
 * states are told apart by shape as well as colour. Reads only; never
 * mutates the graph, sim or monitor.
 */
export function renderHeatmap(ctx: RenderContext, graph: RoadGraph, monitor: NetworkMonitor, v: Viewport): void {
  const s = v.scale
  const roadWidth = 2 * ROAD_GEOMETRY.laneWidth * s
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // Draw coolest first so hot roads sit on top where they meet.
  const roads = monitor.roads().filter((r) => r.heat >= HEATMAP_MIN_HEAT).reverse()
  for (const road of roads) {
    const edge = graph.getEdge(road.edge)
    const a = edge && graph.getNode(edge.a)
    const b = edge && graph.getNode(edge.b)
    if (!a || !b) continue
    const pa = worldToScreen(v, a.position)
    const pb = worldToScreen(v, b.position)
    if (road.persistent) {
      ctx.setLineDash([Math.max(3, s * 0.3), Math.max(3, s * 0.25)])
      ctx.strokeStyle = COLORS.heatBottleneck
      ctx.lineWidth = roadWidth * 1.35
      line(ctx, pa, pb)
    }
    ctx.setLineDash([])
    ctx.strokeStyle = heatColor(road.heat)
    ctx.lineWidth = roadWidth * (road.persistent ? 1 : 0.9)
    line(ctx, pa, pb)
  }

  ctx.setLineDash([])
  const r = Math.max(6, s * 0.55)
  for (const id of monitor.blockedJunctions()) {
    const node = graph.getNode(id)
    if (!node) continue
    const p = worldToScreen(v, node.position)
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.lineWidth = Math.max(2, s * 0.14)
    ctx.strokeStyle = COLORS.heatBlocked
    ctx.stroke()
    const k = r * 0.45
    ctx.lineWidth = Math.max(1.5, s * 0.09)
    ctx.strokeStyle = COLORS.buildOutline
    ctx.beginPath()
    ctx.moveTo(p.x - k, p.y - k)
    ctx.lineTo(p.x + k, p.y + k)
    ctx.moveTo(p.x + k, p.y - k)
    ctx.lineTo(p.x - k, p.y + k)
    ctx.stroke()
  }
  ctx.restore()
}

function line(ctx: RenderContext, a: { x: number; y: number }, b: { x: number; y: number }): void {
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
}
