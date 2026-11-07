import { describe, expect, it } from 'vitest'
import { generateWorld, isPassable, tileIndex, type World } from '@game/world'
import { reachableNodes, SEEDS } from './helpers'

describe('world generation determinism', () => {
  it('produces an identical world for the same seed', () => {
    expect(JSON.stringify(generateWorld(1234))).toBe(JSON.stringify(generateWorld(1234)))
    expect(JSON.stringify(generateWorld('meadow'))).toBe(JSON.stringify(generateWorld('meadow')))
  })

  it('produces meaningfully different worlds for different seeds', () => {
    const a = generateWorld(1)
    const b = generateWorld(2)
    const differingTiles = a.terrain.filter((t, i) => t !== b.terrain[i]).length
    expect(differingTiles / a.terrain.length).toBeGreaterThan(0.2)
    const centres = (w: World) => w.settlements.map((s) => `${s.tile.tx},${s.tile.ty}`).sort()
    expect(centres(a)).not.toEqual(centres(b))
  })

  it('uses the 40 × 30 default and respects size options', () => {
    expect(generateWorld(5)).toMatchObject({ width: 40, height: 30 })
    const w = generateWorld(5, { width: 24, height: 18, settlementCount: 3 })
    expect(w.terrain).toHaveLength(24 * 18)
    expect(w.settlements).toHaveLength(3)
  })

  it('returns frozen data', () => {
    const w = generateWorld(9)
    expect(Object.isFrozen(w)).toBe(true)
    expect(Object.isFrozen(w.roads.segments[0])).toBe(true)
  })
})

describe.each(SEEDS)('world validity (seed %i)', (seed) => {
  const world = generateWorld(seed)
  const nodeById = new Map(world.roads.nodes.map((n) => [n.id, n]))

  it('places the requested settlements and portals', () => {
    expect(world.settlements).toHaveLength(5)
    expect(world.portals).toHaveLength(4)
    for (const p of world.portals) {
      const { tx, ty } = p.tile
      const onEdge = tx === 0 || ty === 0 || tx === world.width - 1 || ty === world.height - 1
      expect(onEdge).toBe(true)
    }
  })

  it('connects every settlement and portal to one road network', () => {
    const targets = [...world.settlements, ...world.portals].map((x) => x.nodeId)
    for (const id of targets) {
      expect(nodeById.has(id)).toBe(true)
      expect(world.road[tileIndex(world.width, nodeById.get(id)!.tile)]).toBe(true)
    }
    const reached = reachableNodes(world, targets[0]!)
    for (const id of targets) expect(reached).toContain(id)
  })

  it('never puts roads, settlements or portals on impassable terrain', () => {
    world.road.forEach((isRoad, i) => {
      if (isRoad) expect(isPassable(world.terrain[i]!)).toBe(true)
    })
    for (const s of world.settlements) {
      expect(world.terrain[tileIndex(world.width, s.tile)]).toBe('settlement')
    }
    for (const p of world.portals) {
      expect(isPassable(world.terrain[tileIndex(world.width, p.tile)]!)).toBe(true)
    }
  })

  it('describes roads as axis-aligned polylines over road tiles between nodes', () => {
    for (const seg of world.roads.segments) {
      expect(seg.from).not.toBe(seg.to)
      const from = nodeById.get(seg.from)!
      const to = nodeById.get(seg.to)!
      expect(seg.points[0]).toEqual({ x: from.x, y: from.y })
      expect(seg.points[seg.points.length - 1]).toEqual({ x: to.x, y: to.y })
      let length = 0
      for (let k = 1; k < seg.points.length; k++) {
        const a = seg.points[k - 1]!
        const b = seg.points[k]!
        expect(a.x === b.x || a.y === b.y).toBe(true)
        const steps = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
        for (let t = 0; t <= steps; t++) {
          const x = Math.floor(a.x + ((b.x - a.x) * t) / steps)
          const y = Math.floor(a.y + ((b.y - a.y) * t) / steps)
          expect(world.road[y * world.width + x]).toBe(true)
        }
        length += steps
      }
      expect(seg.length).toBe(length)
    }
  })
})

describe('generation fallback', () => {
  it('uses the documented no-water fallback when water makes a map unconnectable', () => {
    const w = generateWorld(42, { waterLevel: 0.95, maxAttempts: 2 })
    expect(w.generation).toEqual({ attempts: 3, fallback: true })
    expect(w.terrain).not.toContain('water')
    const ids = [...w.settlements, ...w.portals].map((x) => x.nodeId)
    const reached = reachableNodes(w, ids[0]!)
    for (const id of ids) expect(reached).toContain(id)
  })

  it('rejects invalid options', () => {
    expect(() => generateWorld(1, { width: 5 })).toThrow(RangeError)
    expect(() => generateWorld(1, { portalCount: 1 })).toThrow(RangeError)
  })
})

describe('road tidiness', () => {
  it.each(SEEDS)('leaves no 2 × 2 blocks of road that could be thinned (seed %i)', (seed) => {
    const w = generateWorld(seed)
    const special = new Set([...w.settlements, ...w.portals].map((x) => tileIndex(w.width, x.tile)))
    for (let y = 0; y < w.height - 1; y++) {
      for (let x = 0; x < w.width - 1; x++) {
        const block = [y * w.width + x, y * w.width + x + 1, (y + 1) * w.width + x, (y + 1) * w.width + x + 1]
        if (block.every((i) => w.road[i])) {
          // Only acceptable when every tile is needed (special or a cut tile).
          expect(block.some((i) => special.has(i))).toBe(true)
        }
      }
    }
  })
})
