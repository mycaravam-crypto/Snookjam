/**
 * Shortest-time route finding over a RoadGraph.
 *
 * Uses Dijkstra's algorithm with a binary heap. Edge cost is free-flow travel
 * time (length / speedLimit); costs are non-negative, so Dijkstra is exact and
 * simple enough for MVP map sizes (~hundreds of nodes). Ties are broken by
 * node id and edge insertion order, so identical graphs always produce
 * identical routes, which keeps the simulation deterministic.
 */
import type { EdgeId, NodeId, RoadEdge, RoadGraph } from './graph'

export interface RouteStep {
  readonly edge: EdgeId
  /** Node the step starts at. */
  readonly from: NodeId
  /** Node the step ends at. */
  readonly to: NodeId
}

export interface Route {
  readonly origin: NodeId
  readonly destination: NodeId
  /** Consecutive steps; step[i].to === step[i+1].from. Empty if origin === destination. */
  readonly steps: readonly RouteStep[]
  /** Visited nodes, origin first, destination last. */
  readonly nodes: readonly NodeId[]
  /** Total expected travel time in seconds. */
  readonly cost: number
  /** Graph version the route was computed against. */
  readonly graphVersion: number
}

export type NoRouteReason = 'unknown-origin' | 'unknown-destination' | 'unreachable'

export type RouteResult = { readonly ok: true; readonly route: Route } | { readonly ok: false; readonly reason: NoRouteReason }

export interface RouteOptions {
  /** Override edge cost (seconds). Return Infinity to forbid an edge. */
  readonly cost?: (edge: RoadEdge, graph: RoadGraph) => number
}

export function findRoute(graph: RoadGraph, origin: NodeId, destination: NodeId, options: RouteOptions = {}): RouteResult {
  if (!graph.hasNode(origin)) return { ok: false, reason: 'unknown-origin' }
  if (!graph.hasNode(destination)) return { ok: false, reason: 'unknown-destination' }
  const costOf = options.cost ?? ((edge: RoadEdge) => graph.travelTime(edge))

  const best = new Map<NodeId, number>([[origin, 0]])
  const via = new Map<NodeId, RouteStep>()
  const done = new Set<NodeId>()
  const heap = new MinHeap()
  heap.push(0, origin)

  while (heap.size > 0) {
    const { cost, node } = heap.pop()
    if (done.has(node)) continue
    done.add(node)
    if (node === destination) break
    for (const edge of graph.edgesAt(node)) {
      if (edge.blocked) continue
      const step = costOf(edge, graph)
      if (!(step >= 0) || step === Infinity) continue
      const next = graph.otherEnd(edge, node)
      if (done.has(next)) continue
      const candidate = cost + step
      if (candidate < (best.get(next) ?? Infinity)) {
        best.set(next, candidate)
        via.set(next, { edge: edge.id, from: node, to: next })
        heap.push(candidate, next)
      }
    }
  }

  if (!done.has(destination)) return { ok: false, reason: 'unreachable' }

  const steps: RouteStep[] = []
  for (let at = destination; at !== origin; ) {
    const step = via.get(at)!
    steps.push(step)
    at = step.from
  }
  steps.reverse()
  const route: Route = {
    origin,
    destination,
    steps,
    nodes: [origin, ...steps.map((s) => s.to)],
    cost: best.get(destination)!,
    graphVersion: graph.version,
  }
  return { ok: true, route }
}

/**
 * True if every step of `route` still exists, is unblocked, and is connected.
 * Use this to decide whether a vehicle must re-plan after the graph changed.
 */
export function isRouteValid(graph: RoadGraph, route: Route, fromStep = 0): boolean {
  if (route.graphVersion === graph.version) return true
  for (let i = fromStep; i < route.steps.length; i++) {
    const step = route.steps[i]!
    const edge = graph.getEdge(step.edge)
    if (!edge || edge.blocked) return false
    const joins = (edge.a === step.from && edge.b === step.to) || (edge.b === step.from && edge.a === step.to)
    if (!joins) return false
  }
  return true
}

/** Binary min-heap keyed by cost, ties broken by node id. */
class MinHeap {
  private readonly items: { cost: number; node: NodeId }[] = []

  get size(): number {
    return this.items.length
  }

  push(cost: number, node: NodeId): void {
    const items = this.items
    items.push({ cost, node })
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!less(items[i]!, items[parent]!)) break
      ;[items[i], items[parent]] = [items[parent]!, items[i]!]
      i = parent
    }
  }

  pop(): { cost: number; node: NodeId } {
    const items = this.items
    const top = items[0]!
    const last = items.pop()!
    if (items.length > 0) {
      items[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < items.length && less(items[l]!, items[m]!)) m = l
        if (r < items.length && less(items[r]!, items[m]!)) m = r
        if (m === i) break
        ;[items[i], items[m]] = [items[m]!, items[i]!]
        i = m
      }
    }
    return top
  }
}

function less(x: { cost: number; node: NodeId }, y: { cost: number; node: NodeId }): boolean {
  return x.cost < y.cost || (x.cost === y.cost && x.node < y.node)
}
