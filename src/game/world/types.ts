/**
 * World data model.
 *
 * World coordinates are measured in tiles: the tile at column `tx`, row `ty`
 * covers [tx, tx + 1) × [ty, ty + 1) and its centre is (tx + 0.5, ty + 0.5).
 * Nothing here depends on screen pixels; see viewport.ts for conversion.
 */

export type Terrain = 'grass' | 'field' | 'forest' | 'water' | 'settlement'

export type Side = 'north' | 'east' | 'south' | 'west'

// One shared point type for world and road graph coordinates (tiles).
import type { NodeId, Point } from '../roads/graph'
export type { Point }

export interface TilePoint {
  readonly tx: number
  readonly ty: number
}

export interface Settlement {
  readonly id: string
  readonly name: string
  /** Centre tile; always a road tile. */
  readonly tile: TilePoint
  /** Half-width of the square footprint in tiles (footprint is 2r+1 wide). */
  readonly radius: number
  /** Road node that serves this settlement. */
  readonly nodeId: NodeId
}

/** A tunnel portal where traffic enters and leaves the map. */
export interface Portal {
  readonly id: string
  readonly side: Side
  /** Edge tile the road reaches; always a road tile. */
  readonly tile: TilePoint
  /** Point on the map boundary where the tunnel mouth is drawn. */
  readonly mouth: Point
  /** Road node at the portal. */
  readonly nodeId: NodeId
}

export type RoadNodeKind = 'junction' | 'end' | 'settlement' | 'portal'

/**
 * A point in the road network where segments meet or end. The id is the
 * tile index (ty * width + tx), so it is stable for a given seed and
 * configuration and is reused as the road graph node id.
 */
export interface WorldRoadNode {
  readonly id: NodeId
  readonly x: number
  readonly y: number
  readonly tile: TilePoint
  readonly kind: RoadNodeKind
}

/** A road between two nodes, as a polyline in world coordinates. */
export interface WorldRoadSegment {
  readonly id: string
  readonly from: NodeId
  readonly to: NodeId
  /** Polyline from `from` to `to`, including both endpoints; bends only. */
  readonly points: readonly Point[]
  /** Length in world units (tiles). */
  readonly length: number
}

/**
 * Generated road network: nodes plus polyline segments. Use
 * createRoadGraph(world) to turn it into a routable RoadGraph.
 */
export interface WorldRoadLayout {
  readonly nodes: readonly WorldRoadNode[]
  readonly segments: readonly WorldRoadSegment[]
}

export interface World {
  readonly seed: number
  readonly width: number
  readonly height: number
  /** Row-major terrain, index = ty * width + tx. */
  readonly terrain: readonly Terrain[]
  /** Row-major road mask, same indexing as terrain. */
  readonly road: readonly boolean[]
  readonly settlements: readonly Settlement[]
  readonly portals: readonly Portal[]
  readonly roads: WorldRoadLayout
  /** How the map was produced; useful for debugging generation. */
  readonly generation: {
    /** Number of attempts used (1 = first try succeeded). */
    readonly attempts: number
    /** True when the no-water fallback was needed. */
    readonly fallback: boolean
  }
}

/** Terrain that roads, settlements and portals may never occupy. */
export function isPassable(terrain: Terrain): boolean {
  return terrain !== 'water'
}

export function tileIndex(width: number, tile: TilePoint): number {
  return tile.ty * width + tile.tx
}

export function tileCenter(tile: TilePoint): Point {
  return { x: tile.tx + 0.5, y: tile.ty + 0.5 }
}

export function terrainAt(world: World, tile: TilePoint): Terrain | undefined {
  if (tile.tx < 0 || tile.ty < 0 || tile.tx >= world.width || tile.ty >= world.height) return undefined
  return world.terrain[tileIndex(world.width, tile)]
}

/** Tile containing a world point, or undefined outside the map. */
export function tileAtPoint(world: World, point: Point): TilePoint | undefined {
  const tile = { tx: Math.floor(point.x), ty: Math.floor(point.y) }
  return terrainAt(world, tile) === undefined ? undefined : tile
}
