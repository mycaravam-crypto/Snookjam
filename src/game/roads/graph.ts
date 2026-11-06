/**
 * Road graph: the authoritative topology used for routing and construction.
 *
 * Nodes are junctions or road endpoints; edges are straight, two-way road
 * segments between two nodes. Positions are world coordinates measured in
 * tiles (not canvas pixels), so the graph is independent of rendering and
 * viewport size.
 *
 * Every mutation increments `version`, so consumers (e.g. vehicles holding a
 * route) can cheaply detect that the topology changed and re-plan at their
 * next decision point.
 */

export type NodeId = number
export type EdgeId = number

export interface Point {
  readonly x: number
  readonly y: number
}

export interface RoadNode {
  readonly id: NodeId
  readonly position: Point
}

export interface RoadEdge {
  readonly id: EdgeId
  /** One endpoint. Edges are two-way; `a`/`b` carry no direction. */
  readonly a: NodeId
  /** The other endpoint. */
  readonly b: NodeId
  /** Straight-line length in tiles, derived from the node positions. */
  readonly length: number
  /** Free-flow speed in tiles per second. */
  readonly speedLimit: number
  /** How many vehicles fit on the edge per direction. */
  readonly capacity: number
  /** A blocked edge exists but cannot be routed through. */
  readonly blocked: boolean
}

export interface EdgeOptions {
  speedLimit?: number
  capacity?: number
  blocked?: boolean
}

/** A point on the network: either a node, or a fraction `t` along an edge. */
export type RoadLocation =
  | { readonly kind: 'node'; readonly node: NodeId }
  | { readonly kind: 'edge'; readonly edge: EdgeId; readonly t: number }

/** Plain-data description of a road network, e.g. from world generation. */
export interface RoadLayout {
  readonly nodes: readonly { readonly id: NodeId; readonly x: number; readonly y: number }[]
  readonly segments: readonly ({ readonly from: NodeId; readonly to: NodeId } & EdgeOptions)[]
}

/** Default free-flow speed in tiles per second. */
export const DEFAULT_SPEED_LIMIT = 2
/** Tiles of road each queued vehicle occupies, used to derive capacity. */
export const VEHICLE_SPACING = 1
/** Locations closer than this (in tiles) are treated as the same point. */
export const EPSILON = 1e-6

export function distance(p: Point, q: Point): number {
  return Math.hypot(q.x - p.x, q.y - p.y)
}

/** Default capacity: how many vehicles fit end to end, at least one. */
export function defaultCapacity(length: number): number {
  return Math.max(1, Math.floor(length / VEHICLE_SPACING))
}

export class RoadGraph {
  private readonly nodeMap = new Map<NodeId, RoadNode>()
  private readonly edgeMap = new Map<EdgeId, RoadEdge>()
  /** node -> ids of incident edges, in insertion order (deterministic). */
  private readonly incidence = new Map<NodeId, EdgeId[]>()
  private nextNodeId = 0
  private nextEdgeId = 0
  private versionCounter = 0

  /** Increments on every topology or attribute change. */
  get version(): number {
    return this.versionCounter
  }

  get nodeCount(): number {
    return this.nodeMap.size
  }

  get edgeCount(): number {
    return this.edgeMap.size
  }

  /** Builds a graph from plain layout data, preserving node ids. */
  static fromLayout(layout: RoadLayout): RoadGraph {
    const graph = new RoadGraph()
    for (const node of layout.nodes) graph.addNode({ x: node.x, y: node.y }, node.id)
    for (const { from, to, ...options } of layout.segments) graph.addEdge(from, to, options)
    return graph
  }

  /** Serialises the graph back to layout data (round-trips with fromLayout). */
  toLayout(): RoadLayout {
    return {
      nodes: [...this.nodeMap.values()].map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
      segments: [...this.edgeMap.values()].map((e) => ({
        from: e.a,
        to: e.b,
        speedLimit: e.speedLimit,
        capacity: e.capacity,
        blocked: e.blocked,
      })),
    }
  }

  addNode(position: Point, id?: NodeId): RoadNode {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      throw new RangeError('node position must be finite')
    }
    const nodeId = id ?? this.nextNodeId
    if (!Number.isInteger(nodeId) || nodeId < 0) throw new RangeError(`invalid node id ${nodeId}`)
    if (this.nodeMap.has(nodeId)) throw new Error(`node ${nodeId} already exists`)
    const node: RoadNode = Object.freeze({ id: nodeId, position: Object.freeze({ x: position.x, y: position.y }) })
    this.nodeMap.set(nodeId, node)
    this.incidence.set(nodeId, [])
    this.nextNodeId = Math.max(this.nextNodeId, nodeId + 1)
    this.versionCounter++
    return node
  }

  addEdge(a: NodeId, b: NodeId, options: EdgeOptions = {}): RoadEdge {
    const na = this.requireNode(a)
    const nb = this.requireNode(b)
    if (a === b) throw new Error('an edge cannot connect a node to itself')
    if (this.edgeBetween(a, b) !== undefined) throw new Error(`nodes ${a} and ${b} are already connected`)
    const length = distance(na.position, nb.position)
    if (length < EPSILON) throw new Error('an edge must have non-zero length')
    const speedLimit = options.speedLimit ?? DEFAULT_SPEED_LIMIT
    const capacity = options.capacity ?? defaultCapacity(length)
    if (!(speedLimit > 0) || !Number.isFinite(speedLimit)) throw new RangeError('speedLimit must be positive')
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer')

    const edge: RoadEdge = Object.freeze({
      id: this.nextEdgeId++,
      a,
      b,
      length,
      speedLimit,
      capacity,
      blocked: options.blocked ?? false,
    })
    this.edgeMap.set(edge.id, edge)
    this.incidence.get(a)!.push(edge.id)
    this.incidence.get(b)!.push(edge.id)
    this.versionCounter++
    return edge
  }

  removeEdge(id: EdgeId): void {
    const edge = this.requireEdge(id)
    this.edgeMap.delete(id)
    for (const end of [edge.a, edge.b]) {
      const list = this.incidence.get(end)!
      list.splice(list.indexOf(id), 1)
    }
    this.versionCounter++
  }

  setBlocked(id: EdgeId, blocked: boolean): void {
    const edge = this.requireEdge(id)
    if (edge.blocked === blocked) return
    this.edgeMap.set(id, Object.freeze({ ...edge, blocked }))
    this.versionCounter++
  }

  getNode(id: NodeId): RoadNode | undefined {
    return this.nodeMap.get(id)
  }

  getEdge(id: EdgeId): RoadEdge | undefined {
    return this.edgeMap.get(id)
  }

  hasNode(id: NodeId): boolean {
    return this.nodeMap.has(id)
  }

  nodes(): RoadNode[] {
    return [...this.nodeMap.values()]
  }

  edges(): RoadEdge[] {
    return [...this.edgeMap.values()]
  }

  /** Edges touching `node`, in deterministic insertion order. */
  edgesAt(node: NodeId): RoadEdge[] {
    return (this.incidence.get(node) ?? []).map((id) => this.edgeMap.get(id)!)
  }

  /** The edge directly connecting `a` and `b`, if any. */
  edgeBetween(a: NodeId, b: NodeId): RoadEdge | undefined {
    for (const id of this.incidence.get(a) ?? []) {
      const edge = this.edgeMap.get(id)!
      if ((edge.a === a && edge.b === b) || (edge.a === b && edge.b === a)) return edge
    }
    return undefined
  }

  /** The endpoint of `edge` that is not `node`. */
  otherEnd(edge: RoadEdge, node: NodeId): NodeId {
    if (edge.a === node) return edge.b
    if (edge.b === node) return edge.a
    throw new Error(`node ${node} is not an endpoint of edge ${edge.id}`)
  }

  /** Expected free-flow travel time for an edge, in seconds. */
  travelTime(edge: RoadEdge): number {
    return edge.length / edge.speedLimit
  }

  /** World position of a road location. */
  positionOf(location: RoadLocation): Point {
    if (location.kind === 'node') return this.requireNode(location.node).position
    const edge = this.requireEdge(location.edge)
    const p = this.requireNode(edge.a).position
    const q = this.requireNode(edge.b).position
    const t = clamp01(location.t)
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }
  }

  /**
   * Returns a node at `location`, splitting the edge if the location lies in
   * its interior. Locations at (or within EPSILON of) an endpoint resolve to
   * that endpoint without changing the graph.
   *
   * When an edge is split, its id is retired and two new edges replace it;
   * `split` reports the mapping so callers can migrate references.
   */
  ensureNodeAt(location: RoadLocation): { node: NodeId; split?: EdgeSplit } {
    if (location.kind === 'node') return { node: this.requireNode(location.node).id }
    const edge = this.requireEdge(location.edge)
    const t = clamp01(location.t)
    if (t * edge.length < EPSILON) return { node: edge.a }
    if ((1 - t) * edge.length < EPSILON) return { node: edge.b }

    const position = this.positionOf({ kind: 'edge', edge: edge.id, t })
    this.removeEdge(edge.id)
    const node = this.addNode(position)
    // Capacity is re-derived from the new lengths; speed and blocking carry over.
    const options = { speedLimit: edge.speedLimit, blocked: edge.blocked }
    const toA = this.addEdge(edge.a, node.id, options)
    const toB = this.addEdge(node.id, edge.b, options)
    return { node: node.id, split: { removed: edge.id, node: node.id, towardA: toA.id, towardB: toB.id } }
  }

  /**
   * Adds a straight road between two existing road locations, splitting edges
   * where an endpoint lies mid-edge. Validation (obstacles, crossings) is the
   * caller's job; this only enforces graph invariants and throws if the
   * connection would be zero-length or duplicate. Nothing is changed on error.
   */
  connect(from: RoadLocation, to: RoadLocation, options: EdgeOptions = {}): ConnectResult {
    const check = this.canConnect(from, to)
    if (!check.ok) throw new Error(`cannot connect: ${check.reason}`)
    const start = this.ensureNodeAt(from)
    // `to` may reference the edge that was just split; remap it if so.
    const end = this.ensureNodeAt(remapLocation(this, to, start.split))
    const edge = this.addEdge(start.node, end.node, options)
    return { edge: edge.id, splits: [start.split, end.split].filter((s): s is EdgeSplit => s !== undefined) }
  }

  /** Checks graph-level validity of a proposed connection without mutating. */
  canConnect(from: RoadLocation, to: RoadLocation): { ok: true } | { ok: false; reason: ConnectRejection } {
    if (!this.locationExists(from) || !this.locationExists(to)) return { ok: false, reason: 'unknown-location' }
    const p = this.positionOf(from)
    const q = this.positionOf(to)
    if (distance(p, q) < EPSILON) return { ok: false, reason: 'zero-length' }
    if (sameEdge(from, to)) return { ok: false, reason: 'duplicate' }
    const a = this.resolveExistingNode(from)
    const b = this.resolveExistingNode(to)
    if (a !== undefined && b !== undefined && this.edgeBetween(a, b)) return { ok: false, reason: 'duplicate' }
    // A location on an edge directly adjacent to the other node would just
    // run along the existing road.
    if (a !== undefined && to.kind === 'edge' && this.touches(to.edge, a)) return { ok: false, reason: 'duplicate' }
    if (b !== undefined && from.kind === 'edge' && this.touches(from.edge, b)) return { ok: false, reason: 'duplicate' }
    return { ok: true }
  }

  /**
   * Nearest point on the road network to `point`, within `maxDistance` tiles.
   * Snaps to a node when the projection is within `nodeSnap` tiles of one.
   * Ties are broken by edge id for determinism.
   */
  nearestLocation(point: Point, maxDistance = Infinity, nodeSnap = 0.5): NearestLocation | undefined {
    let best: { edge: RoadEdge; t: number; dist: number } | undefined
    for (const edge of this.edgeMap.values()) {
      const p = this.requireNode(edge.a).position
      const q = this.requireNode(edge.b).position
      const t = projectT(point, p, q)
      const dist = distance(point, { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
      if (dist <= maxDistance && (!best || dist < best.dist - EPSILON)) best = { edge, t, dist }
    }
    if (best) {
      const fromA = best.t * best.edge.length
      const fromB = (1 - best.t) * best.edge.length
      const snapNode = fromA <= Math.min(nodeSnap, fromB) ? best.edge.a : fromB <= nodeSnap ? best.edge.b : undefined
      if (snapNode !== undefined) {
        const position = this.requireNode(snapNode).position
        return { location: { kind: 'node', node: snapNode }, position, distance: distance(point, position) }
      }
    }
    // Isolated nodes (no edges yet) are valid connection points too.
    let isolated: { node: RoadNode; dist: number } | undefined
    for (const node of this.nodeMap.values()) {
      if (this.incidence.get(node.id)!.length > 0) continue
      const dist = distance(point, node.position)
      if (dist <= maxDistance && (!isolated || dist < isolated.dist - EPSILON)) isolated = { node, dist }
    }
    if (isolated && (!best || isolated.dist < best.dist)) {
      return { location: { kind: 'node', node: isolated.node.id }, position: isolated.node.position, distance: isolated.dist }
    }
    if (!best) return undefined
    const location: RoadLocation = { kind: 'edge', edge: best.edge.id, t: best.t }
    return { location, position: this.positionOf(location), distance: best.dist }
  }

  private locationExists(location: RoadLocation): boolean {
    return location.kind === 'node' ? this.nodeMap.has(location.node) : this.edgeMap.has(location.edge)
  }

  /** The node a location resolves to without splitting, if any. */
  private resolveExistingNode(location: RoadLocation): NodeId | undefined {
    if (location.kind === 'node') return location.node
    const edge = this.requireEdge(location.edge)
    const t = clamp01(location.t)
    if (t * edge.length < EPSILON) return edge.a
    if ((1 - t) * edge.length < EPSILON) return edge.b
    return undefined
  }

  private touches(edgeId: EdgeId, node: NodeId): boolean {
    const edge = this.requireEdge(edgeId)
    return edge.a === node || edge.b === node
  }

  private requireNode(id: NodeId): RoadNode {
    const node = this.nodeMap.get(id)
    if (!node) throw new Error(`unknown node ${id}`)
    return node
  }

  private requireEdge(id: EdgeId): RoadEdge {
    const edge = this.edgeMap.get(id)
    if (!edge) throw new Error(`unknown edge ${id}`)
    return edge
  }
}

export interface EdgeSplit {
  /** The retired edge id. */
  readonly removed: EdgeId
  /** The new junction node. */
  readonly node: NodeId
  /** New edge from the old `a` endpoint to the junction. */
  readonly towardA: EdgeId
  /** New edge from the junction to the old `b` endpoint. */
  readonly towardB: EdgeId
}

export interface ConnectResult {
  readonly edge: EdgeId
  readonly splits: readonly EdgeSplit[]
}

export type ConnectRejection = 'unknown-location' | 'zero-length' | 'duplicate'

export interface NearestLocation {
  readonly location: RoadLocation
  /** Snapped world position. */
  readonly position: Point
  /** Distance from the query point to `position`. */
  readonly distance: number
}

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t))
}

function projectT(point: Point, p: Point, q: Point): number {
  const dx = q.x - p.x
  const dy = q.y - p.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return 0
  return clamp01(((point.x - p.x) * dx + (point.y - p.y) * dy) / lengthSq)
}

function sameEdge(from: RoadLocation, to: RoadLocation): boolean {
  return from.kind === 'edge' && to.kind === 'edge' && from.edge === to.edge
}

function remapLocation(graph: RoadGraph, location: RoadLocation, split: EdgeSplit | undefined): RoadLocation {
  if (!split || location.kind !== 'edge' || location.edge !== split.removed) return location
  // Find which half contains the original fraction.
  const towardA = graph.getEdge(split.towardA)!
  const total = towardA.length + graph.getEdge(split.towardB)!.length
  const cut = towardA.length / total
  const t = clamp01(location.t)
  if (t <= cut) return { kind: 'edge', edge: split.towardA, t: cut === 0 ? 0 : t / cut }
  return { kind: 'edge', edge: split.towardB, t: (t - cut) / (1 - cut) }
}
