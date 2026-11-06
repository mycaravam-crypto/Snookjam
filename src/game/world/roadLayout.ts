import type { Point, RoadLayout, RoadNode, RoadNodeKind, RoadSegment } from './types'

/**
 * Converts a road tile mask into a node/segment layout.
 *
 * A tile becomes a node when it is a dead end, a junction (3+ road
 * neighbours) or is marked special (settlement centres, portals). Runs of
 * ordinary 2-neighbour tiles between nodes become one segment whose polyline
 * keeps only the bends. Cycles that would start and end on the same node are
 * split by promoting their middle tile to a node, so no segment is a
 * self-loop.
 */
export function extractRoadLayout(
  width: number,
  height: number,
  road: readonly boolean[],
  special: ReadonlyMap<number, RoadNodeKind>,
): RoadLayout {
  const forced = new Set<number>()
  for (;;) {
    const result = tryExtract(width, height, road, special, forced)
    if (result.kind === 'ok') return result.layout
    forced.add(result.promote)
  }
}

type Attempt = { kind: 'ok'; layout: RoadLayout } | { kind: 'retry'; promote: number }

function tryExtract(
  width: number,
  height: number,
  road: readonly boolean[],
  special: ReadonlyMap<number, RoadNodeKind>,
  forced: ReadonlySet<number>,
): Attempt {
  const neighbours = (i: number): number[] => {
    const x = i % width
    const y = Math.floor(i / width)
    const out: number[] = []
    if (y > 0 && road[i - width]) out.push(i - width)
    if (x < width - 1 && road[i + 1]) out.push(i + 1)
    if (y < height - 1 && road[i + width]) out.push(i + width)
    if (x > 0 && road[i - 1]) out.push(i - 1)
    return out
  }
  const isNode = (i: number) => special.has(i) || forced.has(i) || neighbours(i).length !== 2

  const nodes: RoadNode[] = []
  const nodeIds = new Map<number, string>()
  for (let i = 0; i < road.length; i++) {
    if (!road[i] || !isNode(i)) continue
    const degree = neighbours(i).length
    const kind: RoadNodeKind = special.get(i) ?? (degree <= 1 ? 'end' : 'junction')
    const tile = { tx: i % width, ty: Math.floor(i / width) }
    const id = `n${i}`
    nodeIds.set(i, id)
    nodes.push({ id, x: tile.tx + 0.5, y: tile.ty + 0.5, tile, kind })
  }

  const segments: RoadSegment[] = []
  const usedSteps = new Set<string>()
  const visitedTiles = new Set<number>()
  for (const [start] of nodeIds) {
    visitedTiles.add(start)
    for (const first of neighbours(start)) {
      if (usedSteps.has(`${start}>${first}`)) continue
      const path = [start]
      let prev = start
      let cur = first
      while (!nodeIds.has(cur)) {
        visitedTiles.add(cur)
        path.push(cur)
        const next = neighbours(cur).find((n) => n !== prev)!
        prev = cur
        cur = next
      }
      path.push(cur)
      if (cur === start) {
        return { kind: 'retry', promote: path[Math.floor(path.length / 2)]! }
      }
      usedSteps.add(`${start}>${first}`)
      usedSteps.add(`${cur}>${prev}`)
      const points = simplify(path.map((i) => ({ x: (i % width) + 0.5, y: Math.floor(i / width) + 0.5 })))
      segments.push({
        id: `s${segments.length}`,
        from: nodeIds.get(start)!,
        to: nodeIds.get(cur)!,
        points,
        length: path.length - 1,
      })
    }
  }

  // A closed loop of 2-neighbour tiles has no node at all; give it one.
  for (let i = 0; i < road.length; i++) {
    if (road[i] && !visitedTiles.has(i)) return { kind: 'retry', promote: i }
  }
  return { kind: 'ok', layout: { nodes, segments } }
}

/** Drops intermediate points that lie on a straight line. */
function simplify(points: Point[]): Point[] {
  if (points.length <= 2) return points
  const out: Point[] = [points[0]!]
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1]!
    const b = points[i]!
    const c = points[i + 1]!
    const collinear = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) === 0
    if (!collinear) out.push(b)
  }
  out.push(points[points.length - 1]!)
  return out
}
