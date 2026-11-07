import { extractRoadLayout } from '../../../src/game/world/roadLayout'
import type { Terrain, World } from '@game/world'

/**
 * Builds a small hand-made world from ASCII rows:
 *   '#' road on grass, '~' water, '.' grass, 'T' forest.
 */
export function asciiWorld(rows: string[]): World {
  const height = rows.length
  const width = rows[0]!.length
  const cells = rows.join('').split('')
  const terrain: Terrain[] = cells.map((c) => (c === '~' ? 'water' : c === 'T' ? 'forest' : 'grass'))
  const road = cells.map((c) => c === '#')
  return {
    seed: 0,
    theme: 'countryside',
    width,
    height,
    terrain,
    road,
    settlements: [],
    portals: [],
    roads: extractRoadLayout(width, height, road, new Map()),
    generation: { attempts: 1, fallback: false },
  }
}

/**
 * A loop road around a pond. Tile (1,1) is node 13, tile (1,5) is node 61.
 * Going round the loop between them costs 22 tiles; a straight road at
 * x = 2.5 from y = 1.5 to y = 5.5 crosses only grass.
 */
export const LOOP = [
  '............',
  '.##########.',
  '.........#..',
  '.....~~..#..',
  '.........#..',
  '.##########.',
  '............',
]
export const TOP_LEFT = 13
export const BOTTOM_LEFT = 61
