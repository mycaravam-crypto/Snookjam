import type { Point, World } from '../world/types'
import { screenAngle, worldRectToScreen, worldToScreen, type Viewport } from '../world/viewport'
import { mixSeed } from '../world/rng'
import { CENTRE_LINE_WIDTH, ROAD_EDGE_WIDTH, ROAD_SURFACE_WIDTH } from './roadStyle'
import { COLORS, TERRAIN_COLORS } from './palette'

/** The subset of CanvasRenderingContext2D the world renderer uses. */
export type RenderContext = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'fillRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'arc'
  | 'closePath'
  | 'fill'
  | 'stroke'
  | 'setLineDash'
  | 'fillText'
  | 'strokeText'
  | 'save'
  | 'restore'
>

export interface RenderOptions {
  /** Draw settlement names (skipped automatically when tiles are tiny). */
  readonly labels?: boolean
}

/**
 * Draws the static world: terrain, settlements, roads and tunnel portals.
 * Reads the world only; never mutates it. Coordinates are CSS pixels, so the
 * caller applies any devicePixelRatio transform before calling.
 */
export function renderWorld(
  ctx: RenderContext,
  world: World,
  viewport: Viewport,
  options: RenderOptions = {},
): void {
  const s = viewport.scale
  ctx.save()
  ctx.fillStyle = COLORS.background
  ctx.fillRect(0, 0, viewport.canvasWidth, viewport.canvasHeight)

  drawTerrain(ctx, world, viewport)
  drawRoads(ctx, world, viewport)
  drawSettlements(ctx, world, viewport, options.labels !== false && s >= 11)
  drawPortals(ctx, world, viewport)
  ctx.restore()
}

/** Deterministic per-tile value in [0, 1) for decoration, independent of any rng state. */
function tileNoise(world: World, i: number, salt: number): number {
  return mixSeed(world.seed, i, salt) / 4294967296
}

function drawTerrain(ctx: RenderContext, world: World, v: Viewport): void {
  const s = v.scale
  // Slight overlap avoids hairline seams between tiles at fractional scales.
  const size = s + 0.5
  for (let ty = 0; ty < world.height; ty++) {
    for (let tx = 0; tx < world.width; tx++) {
      const i = ty * world.width + tx
      const terrain = world.terrain[i]!
      // Decorations below are laid out in screen space, so they stay upright
      // whether or not the map is rotated.
      const { x, y } = worldRectToScreen(v, tx, ty, 1, 1)
      ctx.fillStyle = TERRAIN_COLORS[terrain]
      ctx.fillRect(x, y, size, size)
      if (s < 6) continue
      if (terrain === 'field') {
        ctx.fillStyle = COLORS.fieldFurrow
        const lw = Math.max(1, s * 0.08)
        for (let k = 1; k < 4; k++) ctx.fillRect(x, y + (k * s) / 4 - lw / 2, size, lw)
      } else if (terrain === 'forest' && !world.road[i]) {
        const cx = x + s * (0.3 + 0.4 * tileNoise(world, i, 1))
        const cy = y + s * (0.3 + 0.4 * tileNoise(world, i, 2))
        ctx.fillStyle = COLORS.tree
        ctx.beginPath()
        ctx.arc(cx, cy, s * 0.38, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = COLORS.treeHighlight
        ctx.beginPath()
        ctx.arc(cx - s * 0.1, cy - s * 0.1, s * 0.14, 0, Math.PI * 2)
        ctx.fill()
      } else if (terrain === 'water' && tileNoise(world, i, 3) < 0.25) {
        ctx.fillStyle = COLORS.waterRipple
        ctx.fillRect(x + s * 0.2, y + s * 0.45, s * 0.35, Math.max(1, s * 0.07))
      }
    }
  }
}

function tracePolyline(ctx: RenderContext, v: Viewport, points: readonly Point[]): void {
  ctx.beginPath()
  points.forEach((p, k) => {
    const q = worldToScreen(v, p)
    if (k === 0) ctx.moveTo(q.x, q.y)
    else ctx.lineTo(q.x, q.y)
  })
}

function drawRoads(ctx: RenderContext, world: World, v: Viewport): void {
  const s = v.scale
  const segments = world.roads.segments
  // Portal roads continue to the tunnel mouth on the map edge.
  const stubs = world.portals.map((p) => [{ x: p.tile.tx + 0.5, y: p.tile.ty + 0.5 }, p.mouth])
  const lines = [...segments.map((seg) => seg.points), ...stubs]
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const passes: [string, number][] = [
    [COLORS.roadEdge, ROAD_EDGE_WIDTH],
    [COLORS.road, ROAD_SURFACE_WIDTH],
  ]
  for (const [color, width] of passes) {
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(2, s * width)
    for (const points of lines) {
      tracePolyline(ctx, v, points)
      ctx.stroke()
    }
  }
  if (s >= 10) {
    ctx.strokeStyle = COLORS.roadMarking
    ctx.lineWidth = Math.max(1, s * CENTRE_LINE_WIDTH)
    ctx.setLineDash([s * 0.25, s * 0.25])
    for (const points of lines) {
      tracePolyline(ctx, v, points)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }
}

function drawSettlements(ctx: RenderContext, world: World, v: Viewport, labels: boolean): void {
  const s = v.scale
  for (const settlement of world.settlements) {
    const { tx, ty } = settlement.tile
    const r = settlement.radius
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const i = (ty + dy) * world.width + tx + dx
        if (world.road[i]) continue
        const { x, y } = worldRectToScreen(v, tx + dx, ty + dy, 1, 1)
        const inset = s * (0.18 + 0.08 * tileNoise(world, i, 4))
        ctx.fillStyle = COLORS.house
        ctx.fillRect(x + inset, y + inset, s - 2 * inset, s - 2 * inset)
        ctx.fillStyle = COLORS.houseRoof
        ctx.fillRect(x + inset, y + inset, s - 2 * inset, (s - 2 * inset) * 0.4)
      }
    }
    if (labels) {
      // Above the village on screen, whatever the map rotation.
      const centre = worldToScreen(v, { x: tx + 0.5, y: ty + 0.5 })
      const p = { x: centre.x, y: centre.y - (r + 0.65) * s }
      ctx.font = `600 ${Math.round(Math.max(11, s * 0.55))}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.strokeStyle = COLORS.labelHalo
      ctx.lineWidth = 3
      ctx.strokeText(settlement.name, p.x, p.y)
      ctx.fillStyle = COLORS.label
      ctx.fillText(settlement.name, p.x, p.y)
    }
  }
}

function drawPortals(ctx: RenderContext, world: World, v: Viewport): void {
  const s = v.scale
  for (const portal of world.portals) {
    const m = worldToScreen(v, portal.mouth)
    const start = screenAngle(v, { north: 0, east: Math.PI / 2, south: Math.PI, west: (3 * Math.PI) / 2 }[portal.side])
    // A half-disc opening facing into the map, with a stone arch.
    ctx.fillStyle = COLORS.tunnel
    ctx.beginPath()
    ctx.arc(m.x, m.y, s * 0.7, start, start + Math.PI)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = COLORS.tunnelArch
    ctx.lineWidth = Math.max(2, s * 0.18)
    ctx.beginPath()
    ctx.arc(m.x, m.y, s * 0.7, start, start + Math.PI)
    ctx.stroke()
  }
}
