import type { World } from '@game/world'

/** Node ids reachable from `start` over road segments. */
export function reachableNodes(world: World, start: number): Set<number> {
  const adjacency = new Map<number, number[]>()
  for (const s of world.roads.segments) {
    adjacency.set(s.from, [...(adjacency.get(s.from) ?? []), s.to])
    adjacency.set(s.to, [...(adjacency.get(s.to) ?? []), s.from])
  }
  const seen = new Set([start])
  const queue = [start]
  while (queue.length > 0) {
    for (const next of adjacency.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen
}

export const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7919 + 1)
