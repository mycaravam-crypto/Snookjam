import { RoadGraph } from '../roads/graph'
import type { World } from './types'

/**
 * Builds the routable road graph from a generated world.
 *
 * The graph uses straight edges, so every bend of a world road segment
 * becomes its own node. Node ids are tile indices (ty * width + tx), which
 * means world node ids, settlement/portal `nodeId`s and bend nodes all share
 * one id space and need no lookup table. The world itself is not modified;
 * player-built roads (#6) mutate the returned graph only.
 */
export function createRoadGraph(world: World): RoadGraph {
  const graph = new RoadGraph()
  const idOf = (x: number, y: number) => Math.floor(y) * world.width + Math.floor(x)
  for (const node of world.roads.nodes) graph.addNode({ x: node.x, y: node.y }, node.id)
  for (const segment of world.roads.segments) {
    const ids = segment.points.map((p) => idOf(p.x, p.y))
    segment.points.forEach((p, k) => {
      const id = ids[k]!
      if (!graph.hasNode(id)) graph.addNode({ x: p.x, y: p.y }, id)
    })
    for (let k = 1; k < ids.length; k++) {
      const a = ids[k - 1]!
      const b = ids[k]!
      if (graph.edgeBetween(a, b) === undefined) graph.addEdge(a, b)
    }
  }
  return graph
}
