import { fractalNoise } from './noise'
import { findGridPath } from './pathfinding'
import { createRng, mixSeed, normalizeSeed, type Rng } from './rng'
import { extractRoadLayout } from './roadLayout'
import {
  isPassable,
  type Portal,
  type RoadNodeKind,
  type Settlement,
  type Side,
  type Terrain,
  type World,
} from './types'

export interface WorldOptions {
  readonly width: number
  readonly height: number
  readonly settlementCount: number
  readonly portalCount: number
  /** Noise threshold below which terrain is water (0 disables water). */
  readonly waterLevel: number
  /** Minimum distance in tiles between settlement centres. */
  readonly settlementSpacing: number
  /** Generation attempts before falling back to a map without water. */
  readonly maxAttempts: number
}

export const DEFAULT_WORLD_OPTIONS: WorldOptions = Object.freeze({
  width: 40,
  height: 30,
  settlementCount: 5,
  portalCount: 4,
  waterLevel: 0.34,
  settlementSpacing: 8,
  maxAttempts: 8,
})

/** Cost of laying a road through each terrain type (water is impassable). */
const ROAD_COST: Record<Terrain, number> = {
  grass: 1,
  field: 1.4,
  forest: 2.5,
  settlement: 1,
  water: Infinity,
}
/** Re-using an existing road is cheap, which merges routes into shared roads. */
const EXISTING_ROAD_COST = 0.35
/** Extra cost for running along the map edge, which reads badly on screen. */
const BORDER_PENALTY = 4

const SETTLEMENT_NAMES = [
  'Ashby', 'Brookfield', 'Cobbleton', 'Dunmore', 'Elmstead', 'Fernhill', 'Greywick',
  'Hollow End', 'Ivybridge', 'Kettlewell', 'Larkspur', 'Millbrook', 'Nettlecombe',
  'Oakridge', 'Pebblesby', 'Quarry Lane', 'Redmarsh', 'Stoneleigh', 'Thistledown', 'Upwell',
]

/**
 * Generates a world from a seed. The same seed and options always produce the
 * same world. Every settlement and portal is connected to one road network
 * and no road crosses water.
 *
 * If a layout cannot be connected (water cuts the map), generation retries
 * with deterministically derived seeds. After `maxAttempts` failures it uses
 * a documented fallback: the same layout process with water disabled, which
 * is always connectable.
 */
export function generateWorld(seed: number | string, overrides: Partial<WorldOptions> = {}): World {
  const options = { ...DEFAULT_WORLD_OPTIONS, ...overrides }
  validateOptions(options)
  const base = normalizeSeed(seed)
  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    const world = tryGenerate(base, attempt, options, false)
    if (world) return world
  }
  const fallback = tryGenerate(base, options.maxAttempts, { ...options, waterLevel: 0 }, true)
  if (!fallback) throw new Error(`world generation failed for seed ${base}; check options`)
  return fallback
}

function validateOptions(o: WorldOptions): void {
  if (o.width < 12 || o.height < 12) throw new RangeError('world must be at least 12 × 12 tiles')
  if (o.settlementCount < 1) throw new RangeError('settlementCount must be at least 1')
  if (o.portalCount < 2) throw new RangeError('portalCount must be at least 2')
  if (o.maxAttempts < 1) throw new RangeError('maxAttempts must be at least 1')
}

function tryGenerate(seed: number, attempt: number, o: WorldOptions, fallback: boolean): World | undefined {
  const rng = createRng(mixSeed(seed, attempt))
  const { width, height } = o
  const terrain = generateTerrain(rng, o)

  const settlementSites = placeSettlements(rng, terrain, o)
  if (settlementSites.length < o.settlementCount) return undefined
  const portalSites = placePortals(rng, terrain, o)
  if (portalSites.length < o.portalCount) return undefined

  for (const site of settlementSites) {
    for (let dy = -site.radius; dy <= site.radius; dy++) {
      for (let dx = -site.radius; dx <= site.radius; dx++) {
        terrain[(site.ty + dy) * width + site.tx + dx] = 'settlement'
      }
    }
  }

  // Connect all points with a minimum spanning tree, routing each edge on the grid.
  const points = [
    ...settlementSites.map((s) => s.ty * width + s.tx),
    ...portalSites.map((p) => p.ty * width + p.tx),
  ]
  const road: boolean[] = new Array(width * height).fill(false)
  const portalTiles = new Set(portalSites.map((p) => p.ty * width + p.tx))
  const onBorder = (i: number) => {
    const x = i % width
    const y = Math.floor(i / width)
    return x === 0 || y === 0 || x === width - 1 || y === height - 1
  }
  const cost = (i: number) => {
    if (road[i]) return EXISTING_ROAD_COST
    const base = ROAD_COST[terrain[i]!]
    return onBorder(i) && !portalTiles.has(i) ? base + BORDER_PENALTY : base
  }
  for (const [a, b] of spanningTree(points, width)) {
    const path = findGridPath(width, height, a, b, cost, EXISTING_ROAD_COST)
    if (!path) return undefined
    for (const i of path) road[i] = true
  }

  const special = new Map<number, RoadNodeKind>()
  settlementSites.forEach((s) => special.set(s.ty * width + s.tx, 'settlement'))
  portalSites.forEach((p) => special.set(p.ty * width + p.tx, 'portal'))
  removeRoadBlocks(road, width, height, special)
  const roads = extractRoadLayout(width, height, road, special)

  const names = rng.shuffle(SETTLEMENT_NAMES)
  const settlements: Settlement[] = settlementSites.map((s, i) => ({
    id: `settlement-${i}`,
    name: names[i % names.length]!,
    tile: { tx: s.tx, ty: s.ty },
    radius: s.radius,
    nodeId: `n${s.ty * width + s.tx}`,
  }))
  const portals: Portal[] = portalSites.map((p, i) => ({
    id: `portal-${i}`,
    side: p.side,
    tile: { tx: p.tx, ty: p.ty },
    mouth: portalMouth(p, width, height),
    nodeId: `n${p.ty * width + p.tx}`,
  }))

  return deepFreeze({
    seed,
    width,
    height,
    terrain,
    road,
    settlements,
    portals,
    roads,
    generation: { attempts: attempt + 1, fallback },
  })
}

function generateTerrain(rng: Rng, o: WorldOptions): Terrain[] {
  const { width, height } = o
  const elevation = fractalNoise(rng, width, height, 10)
  const moisture = fractalNoise(rng, width, height, 7)
  const farmland = fractalNoise(rng, width, height, 5, 2)
  const terrain: Terrain[] = new Array(width * height)
  for (let i = 0; i < terrain.length; i++) {
    const e = elevation[i]!
    const m = moisture[i]!
    if (e < o.waterLevel) terrain[i] = 'water'
    else if (m > 0.6) terrain[i] = 'forest'
    else if (farmland[i]! > 0.55 && m < 0.55) terrain[i] = 'field'
    else terrain[i] = 'grass'
  }
  return terrain
}

interface SettlementSite {
  tx: number
  ty: number
  radius: number
}

function placeSettlements(rng: Rng, terrain: Terrain[], o: WorldOptions): SettlementSite[] {
  const { width, height } = o
  const radius = 1
  const margin = radius + 3
  const candidates: { tx: number; ty: number }[] = []
  for (let ty = margin; ty < height - margin; ty++) {
    for (let tx = margin; tx < width - margin; tx++) {
      if (areaPassable(terrain, width, tx, ty, radius + 1)) candidates.push({ tx, ty })
    }
  }
  const sites: SettlementSite[] = []
  for (const c of rng.shuffle(candidates)) {
    if (sites.length >= o.settlementCount) break
    const farEnough = sites.every((s) => Math.hypot(s.tx - c.tx, s.ty - c.ty) >= o.settlementSpacing)
    if (farEnough) sites.push({ ...c, radius })
  }
  return sites
}

function areaPassable(terrain: Terrain[], width: number, cx: number, cy: number, r: number): boolean {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (!isPassable(terrain[(cy + dy) * width + cx + dx]!)) return false
    }
  }
  return true
}

interface PortalSite {
  tx: number
  ty: number
  side: Side
}

const SIDES: readonly Side[] = ['north', 'east', 'south', 'west']

function placePortals(rng: Rng, terrain: Terrain[], o: WorldOptions): PortalSite[] {
  const { width, height } = o
  const sites: PortalSite[] = []
  // Spread portals over the sides: every side once before any side repeats.
  const order: Side[] = []
  while (order.length < o.portalCount) order.push(...rng.shuffle(SIDES))
  for (const side of order.slice(0, o.portalCount)) {
    const along = side === 'north' || side === 'south' ? width : height
    const options: PortalSite[] = []
    for (let k = 3; k < along - 3; k++) {
      const site = edgeTile(side, k, width, height)
      const inward = stepInward(site, width, height)
      const ok =
        isPassable(terrain[site.ty * width + site.tx]!) &&
        isPassable(terrain[inward.ty * width + inward.tx]!) &&
        sites.every((s) => Math.abs(s.tx - site.tx) + Math.abs(s.ty - site.ty) >= 6)
      if (ok) options.push(site)
    }
    if (options.length > 0) sites.push(rng.pick(options))
  }
  return sites
}

function edgeTile(side: Side, k: number, width: number, height: number): PortalSite {
  switch (side) {
    case 'north':
      return { tx: k, ty: 0, side }
    case 'south':
      return { tx: k, ty: height - 1, side }
    case 'west':
      return { tx: 0, ty: k, side }
    case 'east':
      return { tx: width - 1, ty: k, side }
  }
}

function stepInward(p: PortalSite, width: number, height: number): { tx: number; ty: number } {
  if (p.ty === 0) return { tx: p.tx, ty: 1 }
  if (p.ty === height - 1) return { tx: p.tx, ty: height - 2 }
  if (p.tx === 0) return { tx: 1, ty: p.ty }
  return { tx: width - 2, ty: p.ty }
}

function portalMouth(p: PortalSite, width: number, height: number) {
  switch (p.side) {
    case 'north':
      return { x: p.tx + 0.5, y: 0 }
    case 'south':
      return { x: p.tx + 0.5, y: height }
    case 'west':
      return { x: 0, y: p.ty + 0.5 }
    case 'east':
      return { x: width, y: p.ty + 0.5 }
  }
}

/**
 * Where two routed roads run side by side they form 2 × 2 blocks of road
 * tiles, which read as tiny loops. Remove a tile from each block when doing
 * so keeps every road tile connected and the tile is not a settlement/portal.
 */
function removeRoadBlocks(
  road: boolean[],
  width: number,
  height: number,
  special: ReadonlyMap<number, RoadNodeKind>,
): void {
  for (let changed = true; changed; ) {
    changed = false
    for (let y = 0; y < height - 1 && !changed; y++) {
      for (let x = 0; x < width - 1 && !changed; x++) {
        const block = [y * width + x, y * width + x + 1, (y + 1) * width + x, (y + 1) * width + x + 1]
        if (!block.every((i) => road[i])) continue
        for (const i of block) {
          if (special.has(i)) continue
          road[i] = false
          if (roadConnected(road, width, height)) {
            changed = true
            break
          }
          road[i] = true
        }
      }
    }
  }
}

function roadConnected(road: readonly boolean[], width: number, height: number): boolean {
  const start = road.indexOf(true)
  if (start < 0) return true
  const seen = new Uint8Array(road.length)
  const stack = [start]
  seen[start] = 1
  let count = 1
  while (stack.length > 0) {
    const i = stack.pop()!
    const x = i % width
    const y = Math.floor(i / width)
    const next = [y > 0 ? i - width : -1, x < width - 1 ? i + 1 : -1, y < height - 1 ? i + width : -1, x > 0 ? i - 1 : -1]
    for (const n of next) {
      if (n >= 0 && road[n] && !seen[n]) {
        seen[n] = 1
        count++
        stack.push(n)
      }
    }
  }
  return count === road.filter(Boolean).length
}

/** Prim's algorithm on straight-line distance between tile indices. */
function spanningTree(points: number[], width: number): [number, number][] {
  const pos = (i: number) => ({ x: i % width, y: Math.floor(i / width) })
  const dist = (a: number, b: number) => {
    const pa = pos(a)
    const pb = pos(b)
    return Math.hypot(pa.x - pb.x, pa.y - pb.y)
  }
  const inTree = [points[0]!]
  const rest = points.slice(1)
  const edges: [number, number][] = []
  while (rest.length > 0) {
    let best: [number, number, number] | undefined
    for (const a of inTree) {
      for (let j = 0; j < rest.length; j++) {
        const d = dist(a, rest[j]!)
        if (!best || d < best[2]) best = [a, j, d]
      }
    }
    const [a, j] = best!
    const b = rest.splice(j, 1)[0]!
    inTree.push(b)
    edges.push([a, b])
  }
  return edges
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}
