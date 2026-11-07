import type { Point, World } from '../world/types'
import { screenAngle, worldRectToScreen, worldToScreen, type Viewport } from '../world/viewport'
import { mixSeed } from '../world/rng'
import { COLORS, CITY_ROOF_COLORS, DESERT_ROOF_COLORS, FIELD_COLORS, FONT_FAMILY, ROOF_COLORS, THEME_TERRAIN_COLORS } from './palette'
import { strokeRoads } from './roadStyle'

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
  /** Additional player-built centre lines, rendered in the same road pass. */
  readonly additionalRoads?: readonly (readonly Point[])[]
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

  drawMapFrame(ctx, world, viewport)
  drawTerrain(ctx, world, viewport)
  drawRoads(ctx, world, viewport, options.additionalRoads ?? [])
  drawSettlements(ctx, world, viewport, options.labels !== false && s >= 11)
  drawPortals(ctx, world, viewport)
  ctx.restore()
}

/** Deterministic per-tile value in [0, 1) for decoration, independent of any rng state. */
function tileNoise(world: World, i: number, salt: number): number {
  return mixSeed(world.seed, i, salt) / 4294967296
}

function pick<T>(list: readonly T[], n: number): T {
  return list[Math.floor(n * list.length) % list.length]!
}

/** A drop shadow and dark rim under the map so it sits on the stage like a board. */
function drawMapFrame(ctx: RenderContext, world: World, v: Viewport): void {
  const m = worldRectToScreen(v, 0, 0, world.width, world.height)
  // Never wider than the margin around the map, so the frame stays on the canvas.
  const pad = Math.max(0, Math.min(Math.max(2, v.scale * 0.15), m.x, m.y))
  ctx.fillStyle = COLORS.mapShadow
  ctx.fillRect(m.x - pad + 3, m.y - pad + 5, m.width + 2 * pad, m.height + 2 * pad)
  ctx.fillStyle = COLORS.mapFrame
  ctx.fillRect(m.x - pad, m.y - pad, m.width + 2 * pad, m.height + 2 * pad)
}

interface Tree {
  x: number
  y: number
  r: number
}

function drawTerrain(ctx: RenderContext, world: World, v: Viewport): void {
  const s = v.scale
  // Slight overlap avoids hairline seams between tiles at fractional scales.
  const size = s + 0.5
  const W = world.width
  const H = world.height
  const isWater = (tx: number, ty: number) =>
    tx < 0 || ty < 0 || tx >= W || ty >= H || world.terrain[ty * W + tx] === 'water'
  const trees: Tree[] = []
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const i = ty * W + tx
      const terrain = world.terrain[i]!
      // Decorations below are laid out in screen space, so they stay upright
      // whether or not the map is rotated.
      const { x, y } = worldRectToScreen(v, tx, ty, 1, 1)
      let base: string = THEME_TERRAIN_COLORS[world.theme][terrain]
      if (terrain === 'field') {
        // Patchwork: neighbouring 3×3 blocks of farmland grow different crops.
        base = world.theme === 'city' ? '#cbd2d5' : world.theme === 'desert' ? pick(['#e6c785', '#dfbd7b', '#f0d69a'], tileNoise(world, i, 9)) : pick(FIELD_COLORS, mixSeed(world.seed, Math.floor(tx / 3) + Math.floor(ty / 3) * 1009, 9) / 4294967296)
      } else if (terrain === 'water') {
        const open = !isWater(tx - 1, ty) || !isWater(tx + 1, ty) || !isWater(tx, ty - 1) || !isWater(tx, ty + 1)
        if (!open) base = COLORS.waterDeep
      }
      ctx.fillStyle = base
      ctx.fillRect(x, y, size, size)
      if (s < 6) continue
      if (terrain === 'field') {
        ctx.fillStyle = COLORS.fieldFurrow
        const lw = Math.max(1, s * 0.1)
        for (let k = 1; k < 4; k++) ctx.fillRect(x, y + (k * s) / 4 - lw / 2, size, lw)
      } else if (terrain === 'forest' && !world.road[i] && world.theme !== 'desert') {
        const n = tileNoise(world, i, 6) < 0.5 ? 2 : 1
        for (let k = 0; k < n; k++) {
          trees.push({
            x: x + s * (0.25 + 0.5 * tileNoise(world, i, 1 + k * 7)),
            y: y + s * (0.25 + 0.5 * tileNoise(world, i, 2 + k * 7)),
            r: s * (n === 1 ? 0.42 : 0.3) * (0.85 + 0.3 * tileNoise(world, i, 8 + k)),
          })
        }
      } else if (terrain === 'forest' && !world.road[i] && world.theme === 'desert') {
        // Sparse desert scrub and exposed rocks instead of dense tree canopies.
        ctx.fillStyle = tileNoise(world, i, 21) > 0.5 ? '#756346' : '#a58a5c'
        const r = s * (0.12 + tileNoise(world, i, 22) * 0.12)
        ctx.fillRect(x + s * 0.35, y + s * 0.45, r * 1.8, r)
      } else if (terrain === 'grass' && !world.road[i] && world.theme === 'countryside') {
        const n = tileNoise(world, i, 10)
        if (n < 0.3) {
          // A small tuft of grass.
          ctx.fillStyle = COLORS.grassTuft
          const tw = Math.max(1, s * 0.07)
          const gx = x + s * (0.2 + 0.6 * tileNoise(world, i, 11))
          const gy = y + s * (0.3 + 0.5 * tileNoise(world, i, 12))
          ctx.fillRect(gx, gy, tw, s * 0.18)
          ctx.fillRect(gx + tw * 1.6, gy + s * 0.04, tw, s * 0.14)
        } else if (n < 0.38) {
          // The occasional flower.
          ctx.fillStyle = pick(COLORS.flower, tileNoise(world, i, 13))
          const fs = Math.max(1.5, s * 0.1)
          ctx.fillRect(x + s * (0.2 + 0.6 * tileNoise(world, i, 14)), y + s * (0.2 + 0.6 * tileNoise(world, i, 15)), fs, fs)
        }
      } else if (terrain === 'water') {
        // Light foam along shores (edges are in world space, so this follows rotation).
        ctx.fillStyle = COLORS.waterShore
        const e = 0.12
        const edges: [boolean, number, number, number, number][] = [
          [!isWater(tx, ty - 1), tx, ty, 1, e],
          [!isWater(tx, ty + 1), tx, ty + 1 - e, 1, e],
          [!isWater(tx - 1, ty), tx, ty, e, 1],
          [!isWater(tx + 1, ty), tx + 1 - e, ty, e, 1],
        ]
        for (const [shore, ex, ey, ew, eh] of edges) {
          if (!shore) continue
          const r = worldRectToScreen(v, ex, ey, ew, eh)
          ctx.fillRect(r.x, r.y, r.width, r.height)
        }
        if (tileNoise(world, i, 3) < 0.25) {
          ctx.fillStyle = COLORS.waterRipple
          ctx.fillRect(x + s * 0.2, y + s * 0.45, s * 0.35, Math.max(1, s * 0.07))
        }
      }
    }
  }
  drawTrees(ctx, trees, s)
}

/** Round tree canopies with a shadow, drawn top to bottom so nearer trees overlap. */
function drawTrees(ctx: RenderContext, trees: Tree[], s: number): void {
  trees.sort((a, b) => a.y - b.y)
  const off = Math.max(1, s * 0.1)
  const circle = (x: number, y: number, r: number) => {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = COLORS.shadow
  for (const t of trees) circle(t.x + off, t.y + off, t.r)
  for (const t of trees) {
    ctx.fillStyle = COLORS.treeDark
    circle(t.x, t.y, t.r)
    ctx.fillStyle = COLORS.tree
    circle(t.x - t.r * 0.08, t.y - t.r * 0.1, t.r * 0.82)
    ctx.fillStyle = COLORS.treeHighlight
    circle(t.x - t.r * 0.3, t.y - t.r * 0.32, t.r * 0.3)
  }
}

function drawRoads(ctx: RenderContext, world: World, v: Viewport, additional: readonly (readonly import('../world/types').Point[])[]): void {
  // Draw generated and player-built roads in one shared stroke pass. Separate
  // passes caused junction shadows and kerbs to be painted over one another.
  const stubs = world.portals.map((p) => [{ x: p.tile.tx + 0.5, y: p.tile.ty + 0.5 }, p.mouth])
  strokeRoads(ctx, v, [...world.roads.segments.map((seg) => seg.points), ...stubs, ...additional])
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
        const inset = s * (0.16 + 0.08 * tileNoise(world, i, 4))
        drawHouse(ctx, x + inset, y + inset, s - 2 * inset, pick(world.theme === 'city' ? CITY_ROOF_COLORS : world.theme === 'desert' ? DESERT_ROOF_COLORS : ROOF_COLORS, tileNoise(world, i, 16)))
      }
    }
    if (labels) {
      // Above the village on screen, whatever the map rotation.
      const centre = worldToScreen(v, { x: tx + 0.5, y: ty + 0.5 })
      const p = { x: centre.x, y: centre.y - (r + 0.65) * s }
      ctx.font = `700 ${Math.round(Math.max(12, s * 0.6))}px ${FONT_FAMILY}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = COLORS.labelHalo
      ctx.lineWidth = 4
      ctx.strokeText(settlement.name, p.x, p.y)
      ctx.fillStyle = COLORS.label
      ctx.fillText(settlement.name, p.x, p.y)
    }
  }
}

/** A little house seen from the front and above: shadow, wall, pitched roof with a ridge and chimney. */
function drawHouse(ctx: RenderContext, x: number, y: number, size: number, roof: string): void {
  const off = Math.max(1, size * 0.12)
  const roofH = size * 0.62
  ctx.fillStyle = COLORS.shadow
  ctx.fillRect(x + off, y + off, size, size)
  // Wall with a darker strip at the base.
  ctx.fillStyle = COLORS.house
  ctx.fillRect(x, y + roofH, size, size - roofH)
  ctx.fillStyle = COLORS.houseShade
  ctx.fillRect(x, y + size - size * 0.1, size, size * 0.1)
  // Roof: lit front slope and shaded back slope, meeting at the ridge.
  ctx.fillStyle = roof
  ctx.fillRect(x - size * 0.06, y, size * 1.12, roofH)
  ctx.fillStyle = COLORS.shadow
  ctx.fillRect(x - size * 0.06, y, size * 1.12, roofH * 0.45)
  ctx.fillStyle = COLORS.roofRidge
  ctx.fillRect(x - size * 0.06, y + roofH * 0.45, size * 1.12, Math.max(1, size * 0.06))
  // Door.
  if (size >= 8) {
    ctx.fillStyle = COLORS.roadEdge
    ctx.fillRect(x + size * 0.42, y + roofH + (size - roofH) * 0.2, size * 0.18, (size - roofH) * 0.8)
  }
}

function drawPortals(ctx: RenderContext, world: World, v: Viewport): void {
  const s = v.scale
  for (const portal of world.portals) {
    const m = worldToScreen(v, portal.mouth)
    const start = screenAngle(v, { north: 0, east: Math.PI / 2, south: Math.PI, west: (3 * Math.PI) / 2 }[portal.side])
    const r = s * 0.75
    const half = (radius: number) => {
      ctx.beginPath()
      ctx.arc(m.x, m.y, radius, start, start + Math.PI)
      ctx.closePath()
    }
    // Stone arch: a thick outer ring split into blocks, with a lighter inner rim.
    ctx.fillStyle = COLORS.tunnelArch
    half(r + s * 0.22)
    ctx.fill()
    ctx.fillStyle = COLORS.tunnelArchLight
    half(r + s * 0.08)
    ctx.fill()
    // Dark mouth with a slightly lighter lining for depth.
    ctx.fillStyle = COLORS.tunnelInner
    half(r)
    ctx.fill()
    ctx.fillStyle = COLORS.tunnel
    half(r * 0.72)
    ctx.fill()
    ctx.strokeStyle = COLORS.roadEdge
    ctx.lineWidth = Math.max(1, s * 0.06)
    ctx.setLineDash([s * 0.18, s * 0.28])
    ctx.beginPath()
    ctx.arc(m.x, m.y, r + s * 0.15, start, start + Math.PI)
    ctx.stroke()
    ctx.setLineDash([])
  }
}
