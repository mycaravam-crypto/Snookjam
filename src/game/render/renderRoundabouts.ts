import { roadWidth, ROAD_GEOMETRY } from '../sim/lanes'
import type { TrafficSim } from '../sim/traffic'
import type { NodeId } from '../roads'
import { worldToScreen, type Viewport } from '../world/viewport'
import type { RenderContext } from './renderWorld'
import { COLORS } from './palette'

export interface RoundaboutRenderOptions {
  /** Node of the selected roundabout, ringed. */
  readonly selected?: NodeId
  /** Mark junctions that can take a roundabout (while the roundabout tool is active). */
  readonly showCandidates?: boolean
}

/** Outer radius of the circulating carriageway, in tiles. */
export const ROUNDABOUT_RADIUS = roadWidth(ROAD_GEOMETRY) * 1.1
/** Radius of the central island, in tiles. */
export const ROUNDABOUT_ISLAND_RADIUS = ROUNDABOUT_RADIUS * 0.42

/**
 * Draws roundabouts: a ring of carriageway around a grassy central island
 * with a light kerb. Drawn under vehicles. Reads the sim; never mutates it.
 */
export function renderRoundabouts(ctx: RenderContext, sim: TrafficSim, v: Viewport, options: RoundaboutRenderOptions = {}): void {
  const s = v.scale
  ctx.save()
  const built = sim.roundabouts()
  if (options.showCandidates) {
    const taken = new Set([...built.map((j) => j.key), ...sim.signals().map((view) => view.junction.key)])
    ctx.setLineDash([Math.max(2, s * 0.15), Math.max(2, s * 0.12)])
    ctx.lineWidth = Math.max(1.5, s * 0.06)
    ctx.strokeStyle = COLORS.signalCandidate
    for (const j of sim.junctions()) {
      if (!sim.isSignalJunction(j) || taken.has(j.key)) continue
      const p = worldToScreen(v, j.center)
      ctx.beginPath()
      ctx.arc(p.x, p.y, s * 0.75, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }
  const selectedKey = options.selected === undefined ? undefined : sim.roundaboutAt(options.selected)?.key
  for (const j of built) {
    const c = worldToScreen(v, j.center)
    ctx.fillStyle = COLORS.roundaboutRoad
    ctx.beginPath()
    ctx.arc(c.x, c.y, s * ROUNDABOUT_RADIUS, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = COLORS.roundaboutIsland
    ctx.strokeStyle = COLORS.roundaboutKerb
    ctx.lineWidth = Math.max(1, s * 0.04)
    ctx.beginPath()
    ctx.arc(c.x, c.y, s * ROUNDABOUT_ISLAND_RADIUS, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    if (j.key === selectedKey) {
      ctx.lineWidth = Math.max(2, s * 0.08)
      ctx.strokeStyle = COLORS.signalSelected
      ctx.beginPath()
      ctx.arc(c.x, c.y, s * 0.95, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  ctx.restore()
}
