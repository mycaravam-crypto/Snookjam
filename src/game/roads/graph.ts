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
    return {
      node: node.id,
      split: {
        removed: edge.id,
        node: node.id,
        a: edge.a,
        b: edge.b,
        towardA: toA.id,
        towardB: toB.id,
        towardALength: toA.length,
        towardBLength: toB.length,
      },
    }
  }

  /**
   * Adds a road between two existing road locations, splitting edges where an
   * endpoint lies mid-edge. With `via` points the road is a polyline: one new
   * node per via point, chained by straight edges (#18 freehand roads).
   *
   * Validation (obstacles, crossings) is the caller's job; this only enforces
   * graph invariants and throws if the connection would be zero-length or
   * duplicate. The mutation is atomic: everything is checked before the graph
   * is touched, so nothing is changed on error.
   */
  connect(from: RoadLocation, to: RoadLocation, options: EdgeOptions = {}, via: readonly Point[] = []): ConnectResult {
    const check = this.canConnect(from, to, via)
    if (!check.ok) throw new Error(`cannot connect: ${check.reason}`)
    const working = this.cloneGraph()
    const result = working.connectMutable(from, to, options, via)
    this.copyFrom(working)
    return result
  }

  private connectMutable(from: RoadLocation, to: RoadLocation, options: EdgeOptions, via: readonly Point[]): ConnectResult {
    const start = this.ensureNodeAt(from)
    const end = this.ensureNodeAt(remapLocation(this, to, start.split))
    const points = [this.getNode(start.node)!.position, ...via, this.getNode(end.node)!.position]
    const splits: EdgeSplit[] = [start.split, end.split].filter((s): s is EdgeSplit => s !== undefined)
    // A freehand bend can land exactly on an existing road. Make that bend
    // the shared graph node instead of leaving two geometries crossing at a
    // point that the segment-intersection test would otherwise treat as an
    // endpoint (and therefore skip).
    const waypointNodes = [
      start.node,
      ...via.map((p) => {
        const nearest = this.nearestLocation(p, 1e-6, 1e-6)
        if (!nearest) return this.addNode(p).id
        const ensured = this.ensureNodeAt(nearest.location)
        if (ensured.split) splits.push(ensured.split)
        return ensured.node
      }),
      end.node,
    ]
    const events: { segment: number; t: number; edge: EdgeId; u: number; node?: NodeId }[] = []

    for (let segment = 0; segment < points.length - 1; segment++) {
      const a = points[segment]!, b = points[segment + 1]!
      for (const edge of this.edges()) {
        const p = this.getNode(edge.a)!.position, q = this.getNode(edge.b)!.position
        const hit = segmentIntersection(a, b, p, q)
        if (!hit || hit.t <= 1e-6 || hit.t >= 1 - 1e-6) continue
        const node = hit.u <= 1e-6 ? edge.a : hit.u >= 1 - 1e-6 ? edge.b : undefined
        events.push({ segment, t: hit.t, edge: edge.id, u: hit.u, ...(node === undefined ? {} : { node }) })
      }
    }

    const byEdge = new Map<EdgeId, typeof events>()
    for (const event of events) {
      if (event.node !== undefined) continue
      const group = byEdge.get(event.edge) ?? []
      group.push(event)
      byEdge.set(event.edge, group)
    }
    for (const [edgeId, group] of byEdge) {
      group.sort((a, b) => a.u - b.u || a.segment - b.segment || a.t - b.t)
      let current = edgeId, previous = 0, previousNode: NodeId | undefined
      for (const event of group) {
        if (event.u - previous <= 1e-6) {
          event.node = previousNode
          continue
        }
        const split = this.ensureNodeAt({ kind: 'edge', edge: current, t: (event.u - previous) / (1 - previous) })
        event.node = split.node
        if (split.split) splits.push(split.split)
        current = split.split!.towardB
        previous = event.u
        previousNode = split.node
      }
    }

    const chain: NodeId[] = [start.node]
    for (let segment = 0; segment < points.length - 1; segment++) {
      const crossings = events.filter((event) => event.segment === segment && event.node !== undefined).sort((a, b) => a.t - b.t)
      for (const event of crossings) if (chain[chain.length - 1] !== event.node) chain.push(event.node!)
      const waypoint = waypointNodes[segment + 1]!
      if (chain[chain.length - 1] !== waypoint) chain.push(waypoint)
    }
    const edges: EdgeId[] = []
    for (let i = 1; i < chain.length; i++) edges.push(this.addEdge(chain[i - 1]!, chain[i]!, options).id)
    if (edges.length === 0) throw new Error('cannot connect: zero-length')
    return { edge: edges[0]!, edges, nodes: chain, splits }
  }

  private cloneGraph(): RoadGraph {
    const clone = new RoadGraph()
    for (const [id, node] of this.nodeMap) clone.nodeMap.set(id, node)
    for (const [id, edge] of this.edgeMap) clone.edgeMap.set(id, edge)
    for (const [id, edges] of this.incidence) clone.incidence.set(id, [...edges])
    clone.nextNodeId = this.nextNodeId
    clone.nextEdgeId = this.nextEdgeId
    clone.versionCounter = this.versionCounter
    return clone
  }

  private copyFrom(source: RoadGraph): void {
    this.nodeMap.clear()
    this.edgeMap.clear()
    this.incidence.clear()
    for (const [id, node] of source.nodeMap) this.nodeMap.set(id, node)
    for (const [id, edge] of source.edgeMap) this.edgeMap.set(id, edge)
    for (const [id, edges] of source.incidence) this.incidence.set(id, [...edges])
    this.nextNodeId = source.nextNodeId
    this.nextEdgeId = source.nextEdgeId
    this.versionCounter = source.versionCounter
  }

  /**
   * Adds a road from an existing network location to a free endpoint.
   * The endpoint becomes a real graph node, so it can be extended or joined
   * by a later construction gesture. All geometry is checked before mutation.
   */
  connectToPoint(from: RoadLocation, point: Point, options: EdgeOptions = {}, via: readonly Point[] = []): ConnectResult {
    if (!this.locationExists(from)) throw new Error('cannot connect: unknown-location')
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('cannot connect: invalid-path')
    const points = [this.positionOf(from), ...via, point]
    for (let i = 1; i < points.length; i++) {
      if (!Number.isFinite(points[i]!.x) || !Number.isFinite(points[i]!.y)) throw new Error('cannot connect: invalid-path')
      if (distance(points[i - 1]!, points[i]!) < EPSILON) throw new Error('cannot connect: zero-length')
    }
    const working = this.cloneGraph()
    const result = working.connectToPointMutable(from, point, options, via)
    this.copyFrom(working)
    return result
  }

  private connectToPointMutable(from: RoadLocation, point: Point, options: EdgeOptions, via: readonly Point[]): ConnectResult {
    const start = this.ensureNodeAt(from)
    const points = [this.getNode(start.node)!.position, ...via, point]
    const splits: EdgeSplit[] = start.split ? [start.split] : []
    const waypointNodes = [
      start.node,
      ...via.map((p) => {
        const nearest = this.nearestLocation(p, 1e-6, 1e-6)
        if (!nearest) return this.addNode(p).id
        const ensured = this.ensureNodeAt(nearest.location)
        if (ensured.split) splits.push(ensured.split)
        return ensured.node
      }),
      this.addNode(point).id,
    ]
    const events: { segment: number; t: number; edge: EdgeId; u: number; node?: NodeId }[] = []
    for (let segment = 0; segment < points.length - 1; segment++) {
      const a = points[segment]!, b = points[segment + 1]!
      for (const edge of this.edges()) {
        const p = this.getNode(edge.a)!.position, q = this.getNode(edge.b)!.position
        const hit = segmentIntersection(a, b, p, q)
        if (!hit || hit.t <= 1e-6 || hit.t >= 1 - 1e-6) continue
        const node = hit.u <= 1e-6 ? edge.a : hit.u >= 1 - 1e-6 ? edge.b : undefined
        events.push({ segment, t: hit.t, edge: edge.id, u: hit.u, ...(node === undefined ? {} : { node }) })
      }
    }
    const byEdge = new Map<EdgeId, typeof events>()
    for (const event of events) {
      if (event.node !== undefined) continue
      const group = byEdge.get(event.edge) ?? []
      group.push(event)
      byEdge.set(event.edge, group)
    }
    for (const [edgeId, group] of byEdge) {
      group.sort((a, b) => a.u - b.u || a.segment - b.segment || a.t - b.t)
      let current = edgeId, previous = 0, previousNode: NodeId | undefined
      for (const event of group) {
        if (event.u - previous <= 1e-6) { event.node = previousNode; continue }
        const split = this.ensureNodeAt({ kind: 'edge', edge: current, t: (event.u - previous) / (1 - previous) })
        event.node = split.node
        if (split.split) splits.push(split.split)
        current = split.split!.towardB
        previous = event.u
        previousNode = split.node
      }
    }
    const chain: NodeId[] = [start.node]
    for (let segment = 0; segment < points.length - 1; segment++) {
      const crossings = events.filter((event) => event.segment === segment && event.node !== undefined).sort((a, b) => a.t - b.t)
      for (const event of crossings) if (chain[chain.length - 1] !== event.node) chain.push(event.node!)
      const waypoint = waypointNodes[segment + 1]!
      if (chain[chain.length - 1] !== waypoint) chain.push(waypoint)
    }
    const edges: EdgeId[] = []
    for (let i = 1; i < chain.length; i++) edges.push(this.addEdge(chain[i - 1]!, chain[i]!, options).id)
    if (edges.length === 0) throw new Error('cannot connect: zero-length')
    return { edge: edges[0]!, edges, nodes: chain, splits }
  }

  /**
   * Checks graph-level validity of a proposed connection without mutating.
   * With `via` points the road may join two points of the same edge or two
   * already-connected nodes (it takes a different path); it must still have
   * distinct ends and no zero-length segments.
   */
  canConnect(
    from: RoadLocation,
    to: RoadLocation,
    via: readonly Point[] = [],
  ): { ok: true } | { ok: false; reason: ConnectRejection } {
    if (!this.locationExists(from) || !this.locationExists(to)) return { ok: false, reason: 'unknown-location' }
    const p = this.positionOf(from)
    const q = this.positionOf(to)
    if (distance(p, q) < EPSILON) return { ok: false, reason: 'zero-length' }
    if (via.length > 0) {
      if (!via.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y))) return { ok: false, reason: 'invalid-path' }
      const points = [p, ...via, q]
      for (let i = 1; i < points.length; i++) {
        if (distance(points[i - 1]!, points[i]!) < EPSILON) return { ok: false, reason: 'zero-length' }
      }
      return { ok: true }
    }
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

/**
 * Describes one edge split. Self-contained (does not need the graph), so a
 * sequence of splits can be replayed in order even when a later split
 * retires an edge created by an earlier one, as when a freehand road starts
 * and ends on the same edge.
 */
export interface EdgeSplit {
  /** The retired edge id. */
  readonly removed: EdgeId
  /** The new junction node. */
  readonly node: NodeId
  /** The retired edge's `a` endpoint. */
  readonly a: NodeId
  /** The retired edge's `b` endpoint. */
  readonly b: NodeId
  /** New edge from the old `a` endpoint to the junction. */
  readonly towardA: EdgeId
  /** New edge from the junction to the old `b` endpoint. */
  readonly towardB: EdgeId
  /** Length of `towardA`, i.e. the junction's distance from `a`. */
  readonly towardALength: number
  /** Length of `towardB`, i.e. the junction's distance from `b`. */
  readonly towardBLength: number
}

export interface ConnectResult {
  /** The first new edge (the only one for a straight road). */
  readonly edge: EdgeId
  /** Every new edge, in order from `from` to `to`. */
  readonly edges: readonly EdgeId[]
  /** The road's nodes in order, including both (possibly new) endpoints. */
  readonly nodes: readonly NodeId[]
  readonly splits: readonly EdgeSplit[]
}

export type ConnectRejection = 'unknown-location' | 'zero-length' | 'duplicate' | 'invalid-path'

export interface NearestLocation {
  readonly location: RoadLocation
  /** Snapped world position. */
  readonly position: Point
  /** Distance from the query point to `position`. */
  readonly distance: number
}

/** Proper intersection of two finite segments, including endpoints on pq. */
function segmentIntersection(a: Point, b: Point, p: Point, q: Point): { t: number; u: number; point: Point } | undefined {
  const rx = b.x - a.x, ry = b.y - a.y, sx = q.x - p.x, sy = q.y - p.y
  const denominator = rx * sy - ry * sx
  if (Math.abs(denominator) < 1e-9) return undefined
  const qpx = p.x - a.x, qpy = p.y - a.y
  const t = (qpx * sy - qpy * sx) / denominator
  const u = (qpx * ry - qpy * rx) / denominator
  if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) return undefined
  return { t: clamp01(t), u: clamp01(u), point: { x: a.x + rx * t, y: a.y + ry * t } }
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
