import { junctionStopDistance, roadWidth, ROAD_GEOMETRY } from '../sim/lanes'
import type { SignalLight } from '../sim/junctions'
import type { TrafficSim } from '../sim/traffic'
import type { NodeId } from '../roads'
import { worldToScreen, type Viewport } from '../world/viewport'
import type { RenderContext } from './renderWorld'
import { COLORS } from './palette'

export interface SignalRenderOptions {
  /** Node of the selected signal, ringed. */
  readonly selected?: NodeId
  /** Mark junctions that can take lights (while the lights tool is active). */
  readonly showCandidates?: boolean
}

const LAMPS: readonly SignalLight[] = ['red', 'amber', 'green']

/**
 * Draws traffic lights (#32): a small three-lamp head beside each
 * approach's stop line, on the kerb to the driver's right. Only the lit lamp
 * is bright, and the lamps keep the usual red-amber-green order, so the state
 * does not rely on colour alone. Reads the sim; never mutates it.
 */
export function renderSignals(ctx: RenderContext, sim: TrafficSim, v: Viewport, options: SignalRenderOptions = {}): void {
  const s = v.scale
  ctx.save()
  if (options.showCandidates) {
    const signalled = new Set([...sim.signals().map((view) => view.junction.key), ...sim.roundabouts().map((j) => j.key)])
    ctx.setLineDash([Math.max(2, s * 0.15), Math.max(2, s * 0.12)])
    ctx.lineWidth = Math.max(1.5, s * 0.06)
    ctx.strokeStyle = COLORS.signalCandidate
    for (const j of sim.junctions()) {
      if (!sim.isSignalJunction(j) || signalled.has(j.key)) continue
      const p = worldToScreen(v, j.center)
      ctx.beginPath()
      ctx.arc(p.x, p.y, s * 0.75, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  const lamp = Math.max(1.8, s * 0.08)
  const stop = junctionStopDistance(ROAD_GEOMETRY)
  const kerb = roadWidth(ROAD_GEOMETRY) / 2 + 0.18
  for (const view of sim.signals()) {
    const selected = options.selected !== undefined && sim.signalAt(options.selected)?.junction.key === view.junction.key
    if (selected) {
      const c = worldToScreen(v, view.junction.center)
      ctx.lineWidth = Math.max(2, s * 0.08)
      ctx.strokeStyle = COLORS.signalSelected
      ctx.beginPath()
      ctx.arc(c.x, c.y, s * 0.95, 0, Math.PI * 2)
      ctx.stroke()
    }
    view.junction.approaches.forEach((approach, i) => {
      const node = approach.position
      const dx = Math.cos(approach.heading)
      const dy = Math.sin(approach.heading)
      // Behind the stop line, on the right-hand kerb (y points down).
      const world = {
        x: node.x - dx * stop + -dy * kerb,
        y: node.y - dy * stop + dx * kerb,
      }
      const p = worldToScreen(v, world)
      drawHead(ctx, p.x, p.y, lamp, view.lights[i]!)
    })
  }
  ctx.restore()
}

function drawHead(ctx: RenderContext, x: number, y: number, r: number, lit: SignalLight): void {
  const w = r * 2.6
  const h = r * 7
  ctx.fillStyle = COLORS.signalHousing
  ctx.fillRect(x - w / 2, y - h / 2, w, h)
  LAMPS.forEach((light, k) => {
    ctx.beginPath()
    ctx.arc(x, y - h / 2 + r * 1.2 + k * r * 2.3, r, 0, Math.PI * 2)
    ctx.fillStyle = light === lit ? COLORS.signal[light] : COLORS.signalOff
    ctx.fill()
  })
}
