/**
 * Deterministic traffic simulation (#5).
 *
 * Vehicles enter at tunnel portals, follow shortest-time routes over the
 * RoadGraph, queue behind each other and leave at their destination portal.
 *
 * Model (discrete, no physics):
 * - Each edge has one lane per direction. A lane holds vehicles ordered
 *   front-first; vehicles never overtake.
 * - A vehicle moves at the edge's speed limit, but never closer than
 *   `minGap` tiles to the vehicle ahead in its lane.
 * - Roads are classic two-lane roads (#22, see lanes.ts): each direction
 *   drives in its own lane on the right, so opposing vehicles pass without
 *   touching. `lanePositionOf` gives the in-lane position; lanes are mitred
 *   at bends and turns so vehicles never jump sideways.
 * - Following distance (`minGap`, centre to centre along the route) is kept
 *   across nodes too: a vehicle looks ahead into the next lanes of its route.
 *   A vehicle may only enter its next lane if that lane is below capacity and
 *   the gap ahead is at least `minGap`; otherwise it waits, which is how
 *   queues form.
 * - Intersections (nodes where three or more roads meet) have a stop line
 *   `stopDistance` before the node and a junction box: one vehicle at a time
 *   holds the box, from crossing its stop line until it is `stopDistance`
 *   past the node, and only enters when it has room to leave. Intersections
 *   joined by a road too short to stop between them share one box. A new vehicle
 *   may enter at most every `junctionClearSec`, so busy intersections become
 *   bottlenecks. Bends and dead ends (degree <= 2) have no such limit.
 * - Routes are re-planned only at junctions (never mid-edge), when the graph
 *   has changed since the route was planned. A vehicle with no route waits at
 *   its junction in the explicit `stuck` state until the graph changes.
 * - Spawns are queued as "pending" and released at a portal when its entry
 *   lane has room, so blocked tunnels build up incoming pressure instead of
 *   dropping traffic.
 *
 * The simulation only advances through `step(dt)`, with dt supplied by a
 * fixed-step clock, so results never depend on rendering frame rate. All
 * randomness comes from the injected source, so a seed fully determines it.
 */
import { DEFAULT_CONFIG } from '../config'
import { junctionStopDistance, laneOffset, minFollowingDistance, ROAD_GEOMETRY, validateRoadGeometry, type RoadGeometry } from './lanes'
import { VEHICLE_SPACING, findRoute, type EdgeSplit, type Point, type NodeId, type RoadGraph, type RouteStep } from '../roads'

/** Structural subset of the world Rng: uniform float in [0, 1). */
export interface RandomSource {
  next(): number
}

export interface TrafficOptions {
  /** Graph nodes where vehicles enter and leave. */
  readonly portals: readonly NodeId[]
  readonly random: RandomSource
  /** Vehicles queued for entry when the simulation starts. */
  readonly startingVehicles?: number
  readonly maxVehicles?: number
  readonly spawnIntervalSec?: number
  readonly minSpawnIntervalSec?: number
  /**
   * Minimum distance in tiles between consecutive vehicles along a route.
   * Defaults to (and must be at least) minFollowingDistance(geometry).
   */
  readonly minGap?: number
  /** Upper bound on queued-but-not-yet-entered spawns. */
  readonly maxPendingSpawns?: number
  /** Seconds an intersection stays occupied after a vehicle crosses it. */
  readonly junctionClearSec?: number
  /** Two-lane road and vehicle dimensions (defaults to ROAD_GEOMETRY). */
  readonly geometry?: RoadGeometry
}

export type VehicleState = 'moving' | 'waiting' | 'stuck'

export interface Vehicle {
  readonly id: number
  readonly origin: NodeId
  readonly destination: NodeId
  /** Planned steps; `steps[stepIndex]` is the edge currently driven. */
  readonly steps: readonly RouteStep[]
  readonly stepIndex: number
  /** Distance travelled along the current edge, in tiles. */
  readonly progress: number
  /** Distance moved in the last step divided by dt (tiles per second). */
  readonly speed: number
  readonly state: VehicleState
  /** Total seconds spent waiting or stuck. */
  readonly waitTime: number
  /** Seconds waited without moving since the vehicle last moved. */
  readonly waitingFor: number
  readonly spawnedAt: number
}

export interface StepReport {
  readonly spawned: number
  readonly exited: number
  /** Spawn attempts dropped because no route existed between portals. */
  readonly unroutable: number
}

export interface TrafficStats {
  readonly time: number
  readonly ticks: number
  readonly active: number
  readonly pendingSpawns: number
  readonly waiting: number
  readonly stuck: number
  readonly totalSpawned: number
  readonly totalExited: number
  readonly totalUnroutable: number
}

interface MutableVehicle {
  id: number
  origin: NodeId
  destination: NodeId
  steps: RouteStep[]
  stepIndex: number
  progress: number
  speed: number
  state: VehicleState
  waitTime: number
  waitingFor: number
  spawnedAt: number
  /** Graph version the remaining steps were planned against. */
  routeVersion: number
  /** Graph version of the last failed re-plan (for stuck vehicles). */
  failedVersion: number
  /** Intersection whose junction box this vehicle currently holds. */
  holding: NodeId | undefined
}

/** Default seconds an intersection is occupied by a crossing vehicle. */
export const DEFAULT_JUNCTION_CLEAR_SEC = 0.6

const laneKey = (step: RouteStep): string => `${step.edge}>${step.from}`

export class TrafficSim {
  private readonly graph: RoadGraph
  private readonly portals: readonly NodeId[]
  private readonly random: RandomSource
  readonly maxVehicles: number
  readonly minSpawnIntervalSec: number
  readonly minGap: number
  readonly maxPendingSpawns: number
  readonly junctionClearSec: number
  readonly geometry: RoadGeometry
  /** Distance before an intersection where vehicles stop (vehicle centre). */
  readonly stopDistance: number

  private spawnInterval: number
  private spawnTimer = 0
  private pending: number
  private nextId = 0
  private time = 0
  private ticks = 0
  private totalSpawned = 0
  private totalExited = 0
  private totalUnroutable = 0
  private readonly fleet = new Map<number, MutableVehicle>()
  /** Lane key -> vehicles, front (highest progress) first. */
  private readonly lanes = new Map<string, MutableVehicle[]>()
  /** Intersection node -> simulation time at which it is free again. */
  private readonly junctionFreeAt = new Map<NodeId, number>()
  /** Junction key -> id of the vehicle holding that junction box. */
  private readonly junctionHolder = new Map<NodeId, number>()
  /**
   * Intersections closer together than a vehicle needs to clear one before
   * stopping at the next form one junction box (keyed by its smallest node
   * id), so a vehicle can never hold one box while waiting for the next.
   */
  private junctionKeys = new Map<NodeId, NodeId>()
  /** Edges inside a combined junction box (no stop line on them). */
  private internalEdges = new Set<number>()
  private junctionsVersion = -1

  constructor(graph: RoadGraph, options: TrafficOptions) {
    this.graph = graph
    this.portals = [...options.portals]
    for (const p of this.portals) if (!graph.hasNode(p)) throw new Error(`portal node ${p} is not in the graph`)
    this.random = options.random
    this.maxVehicles = options.maxVehicles ?? DEFAULT_CONFIG.maxVehicles
    this.spawnInterval = options.spawnIntervalSec ?? DEFAULT_CONFIG.initialSpawnIntervalSec
    this.minSpawnIntervalSec = options.minSpawnIntervalSec ?? DEFAULT_CONFIG.minSpawnIntervalSec
    this.geometry = options.geometry ?? ROAD_GEOMETRY
    this.minGap = options.minGap ?? Math.max(VEHICLE_SPACING, minFollowingDistance(this.geometry))
    this.junctionClearSec = options.junctionClearSec ?? DEFAULT_JUNCTION_CLEAR_SEC
    this.maxPendingSpawns = options.maxPendingSpawns ?? this.maxVehicles
    this.pending = Math.min(options.startingVehicles ?? DEFAULT_CONFIG.startingVehicles, this.maxPendingSpawns)
    if (!(this.minGap > 0)) throw new RangeError('minGap must be positive')
    validateRoadGeometry(this.geometry, this.minGap)
    this.stopDistance = junctionStopDistance(this.geometry)
    this.setSpawnInterval(this.spawnInterval)
  }

  get spawnIntervalSec(): number {
    return this.spawnInterval
  }

  /** Changes spawn pressure (e.g. per level); clamped to the minimum. */
  setSpawnInterval(seconds: number): void {
    if (!(seconds > 0)) throw new RangeError('spawn interval must be positive')
    this.spawnInterval = Math.max(this.minSpawnIntervalSec, seconds)
  }

  /** Queues extra vehicles for entry (bounded by maxPendingSpawns). */
  queueSpawns(count: number): void {
    this.pending = Math.min(this.maxPendingSpawns, this.pending + Math.max(0, Math.floor(count)))
  }

  vehicles(): readonly Vehicle[] {
    return [...this.fleet.values()]
  }

  getVehicle(id: number): Vehicle | undefined {
    return this.fleet.get(id)
  }

  stats(): TrafficStats {
    let waiting = 0
    let stuck = 0
    for (const v of this.fleet.values()) {
      if (v.state === 'waiting') waiting++
      else if (v.state === 'stuck') stuck++
    }
    return {
      time: this.time,
      ticks: this.ticks,
      active: this.fleet.size,
      pendingSpawns: this.pending,
      waiting,
      stuck,
      totalSpawned: this.totalSpawned,
      totalExited: this.totalExited,
      totalUnroutable: this.totalUnroutable,
    }
  }

  /** Vehicles currently in the lane `edge` travelled from `from`, front first. */
  laneOccupants(edge: number, from: NodeId): readonly Vehicle[] {
    return this.lanes.get(`${edge}>${from}`) ?? []
  }

  /** World position and heading (radians) of a vehicle, for rendering. */
  positionOf(vehicle: Vehicle): { position: Point; heading: number } {
    const step = vehicle.steps[vehicle.stepIndex]!
    const edge = this.graph.getEdge(step.edge)!
    const p = this.graph.getNode(step.from)!.position
    const q = this.graph.getNode(step.to)!.position
    const t = Math.min(1, vehicle.progress / edge.length)
    return {
      position: { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t },
      heading: Math.atan2(q.y - p.y, q.x - p.x),
    }
  }

  /**
   * Position and heading of a vehicle in its lane (right-hand traffic).
   *
   * On straight stretches the vehicle is on the route's centre line shifted
   * right by `laneOffset`, at its exact distance along the edge. Within
   * `cornerRadius` of a node where the route changes direction it follows a
   * quadratic curve from the incoming lane to the outgoing lane through the
   * point where the two lanes meet, so position and heading are continuous
   * and the body stays in its own lane.
   */
  lanePositionOf(vehicle: Vehicle): { position: Point; heading: number } {
    const i = vehicle.stepIndex
    const step = vehicle.steps[i]!
    const length = this.graph.getEdge(step.edge)!.length
    const s = Math.min(length, Math.max(0, vehicle.progress))
    const prev = i > 0 ? vehicle.steps[i - 1] : undefined
    const next = i + 1 < vehicle.steps.length ? vehicle.steps[i + 1] : undefined
    if (next) {
      const r = this.cornerRadiusAt(step, next)
      if (r > 0 && length - s < r) return this.corner(step, next, r, (r - (length - s)) / (2 * r))
    }
    if (prev) {
      const r = this.cornerRadiusAt(prev, step)
      if (r > 0 && s < r) return this.corner(prev, step, r, 0.5 + s / (2 * r))
    }
    const p = this.graph.getNode(step.from)!.position
    const a = this.direction(step)
    const d = laneOffset(this.geometry)
    return { position: { x: p.x - a.y * d + a.x * s, y: p.y + a.x * d + a.y * s }, heading: Math.atan2(a.y, a.x) }
  }

  /** Curve radius at the node between two consecutive steps (0 = straight on). */
  private cornerRadiusAt(inStep: RouteStep, outStep: RouteStep): number {
    const a = this.direction(inStep)
    const b = this.direction(outStep)
    if (a.x * b.x + a.y * b.y > 1 - 1e-9) return 0
    const lenIn = this.graph.getEdge(inStep.edge)!.length
    const lenOut = this.graph.getEdge(outStep.edge)!.length
    return Math.min(this.geometry.cornerRadius, lenIn / 2, lenOut / 2)
  }

  /** Point on the turning curve at parameter tau in [0, 1]. */
  private corner(inStep: RouteStep, outStep: RouteStep, r: number, tau: number): { position: Point; heading: number } {
    const node = this.graph.getNode(inStep.to)!.position
    const a = this.direction(inStep)
    const b = this.direction(outStep)
    const d = laneOffset(this.geometry)
    const m = miterOffset(a, b, d)
    const p0 = { x: node.x - a.y * d - a.x * r, y: node.y + a.x * d - a.y * r }
    const p1 = { x: node.x + m.x, y: node.y + m.y }
    const p2 = { x: node.x - b.y * d + b.x * r, y: node.y + b.x * d + b.y * r }
    const u = 1 - tau
    const position = {
      x: u * u * p0.x + 2 * u * tau * p1.x + tau * tau * p2.x,
      y: u * u * p0.y + 2 * u * tau * p1.y + tau * tau * p2.y,
    }
    const tx = u * (p1.x - p0.x) + tau * (p2.x - p1.x)
    const ty = u * (p1.y - p0.y) + tau * (p2.y - p1.y)
    return { position, heading: Math.atan2(ty, tx) }
  }

  /** Vehicle currently holding the junction box containing `node`, if any. */
  junctionHolderAt(node: NodeId): number | undefined {
    this.refreshJunctions()
    const key = this.junctionKeys.get(node)
    return key === undefined ? undefined : this.junctionHolder.get(key)
  }

  /** Advances the simulation by one fixed step of `dt` seconds. */
  step(dt: number): StepReport {
    if (!(dt > 0)) throw new RangeError('dt must be positive')
    this.time += dt
    this.ticks++
    let exited = 0
    let unroutable = 0

    // 0. Junction boxes: release vehicles that have cleared them, then let
    //    waiting vehicles at stop lines in, oldest first.
    this.refreshJunctions()
    this.updateJunctions()

    // 1. Movement within lanes, front to back.
    const atEnd: MutableVehicle[] = []
    for (const lane of this.lanes.values()) {
      let limit = Infinity
      for (const v of lane) {
        const step = v.steps[v.stepIndex]!
        const edge = this.graph.getEdge(step.edge)!
        if (limit === Infinity) limit = this.frontLimit(v, edge.length)
        const target = Math.min(edge.length, limit, v.progress + edge.speedLimit * dt)
        const moved = Math.max(0, target - v.progress)
        v.progress += moved
        v.speed = moved / dt
        v.state = moved > 1e-9 ? 'moving' : v.state === 'stuck' ? 'stuck' : 'waiting'
        if (v.progress >= edge.length - 1e-9) atEnd.push(v)
        limit = v.progress - this.minGap
      }
    }

    // 2. Junction transitions, oldest vehicle first for fairness/determinism.
    atEnd.sort((a, b) => a.id - b.id)
    for (const v of atEnd) {
      const result = this.advanceAtJunction(v)
      if (result === 'exited') exited++
    }

    // 3. Spawning.
    this.spawnTimer += dt
    while (this.spawnTimer >= this.spawnInterval) {
      this.spawnTimer -= this.spawnInterval
      this.queueSpawns(1)
    }
    const spawnedBefore = this.totalSpawned
    while (this.pending > 0 && this.fleet.size < this.maxVehicles) {
      const outcome = this.trySpawn()
      if (outcome === 'blocked') break
      this.pending--
      if (outcome === 'unroutable') unroutable++
    }

    for (const v of this.fleet.values()) {
      if (v.state === 'moving') {
        v.waitingFor = 0
      } else {
        v.waitTime += dt
        v.waitingFor += dt
      }
    }
    this.totalExited += exited
    this.totalUnroutable += unroutable
    return { spawned: this.totalSpawned - spawnedBefore, exited, unroutable }
  }

  /**
   * Migrates vehicles after `RoadGraph.connect`/`ensureNodeAt` split an edge,
   * so nobody teleports: each vehicle keeps its world position and the
   * removed edge is replaced by its two halves in every planned route.
   */
  applySplit(split: EdgeSplit): void {
    const towardA = this.graph.getEdge(split.towardA)
    const towardB = this.graph.getEdge(split.towardB)
    if (!towardA || !towardB) throw new Error('split edges are not in the graph')
    const a = this.graph.otherEnd(towardA, split.node)
    const b = this.graph.otherEnd(towardB, split.node)
    const expand = (step: RouteStep): RouteStep[] =>
      step.from === a
        ? [
            { edge: towardA.id, from: a, to: split.node },
            { edge: towardB.id, from: split.node, to: b },
          ]
        : [
            { edge: towardB.id, from: b, to: split.node },
            { edge: towardA.id, from: split.node, to: a },
          ]

    const removedLanes = [`${split.removed}>${a}`, `${split.removed}>${b}`]
    for (const v of this.fleet.values()) {
      const steps: RouteStep[] = []
      let stepIndex = 0
      let progress = v.progress
      v.steps.forEach((s, i) => {
        const isCurrent = i === v.stepIndex
        if (s.edge !== split.removed) {
          if (isCurrent) stepIndex = steps.length
          steps.push(s)
          return
        }
        const halves = expand(s)
        if (isCurrent) {
          const firstLength = this.graph.getEdge(halves[0]!.edge)!.length
          const onSecond = v.progress > firstLength
          stepIndex = steps.length + (onSecond ? 1 : 0)
          progress = onSecond ? v.progress - firstLength : v.progress
        }
        steps.push(...halves)
      })
      v.steps = steps
      v.stepIndex = stepIndex
      v.progress = progress
    }

    for (const key of removedLanes) {
      const lane = this.lanes.get(key)
      if (!lane) continue
      this.lanes.delete(key)
      for (const v of lane) this.laneFor(v.steps[v.stepIndex]!).push(v)
    }
    for (const lane of this.lanes.values()) lane.sort((x, y) => y.progress - x.progress || x.id - y.id)
  }

  private advanceAtJunction(v: MutableVehicle): 'exited' | 'moved' | 'held' {
    const current = v.steps[v.stepIndex]!
    const node = current.to
    if (node === v.destination && v.stepIndex === v.steps.length - 1) {
      this.removeVehicle(v, current)
      return 'exited'
    }

    // Re-plan at this junction if the graph changed since the route was made.
    if (v.routeVersion !== this.graph.version && v.failedVersion !== this.graph.version) {
      const result = findRoute(this.graph, node, v.destination)
      if (result.ok && result.route.steps.length > 0) {
        v.steps = [...v.steps.slice(0, v.stepIndex + 1), ...result.route.steps]
        v.routeVersion = this.graph.version
      } else if (!this.remainingValid(v)) {
        v.failedVersion = this.graph.version
      } else {
        v.routeVersion = this.graph.version
      }
    }
    if (!this.remainingValid(v)) {
      v.state = 'stuck'
      return 'held'
    }

    const next = v.steps[v.stepIndex + 1]!
    const key = this.junctionKeys.get(node)
    if (key !== undefined && this.junctionHolder.get(key) !== v.id) {
      v.state = 'waiting'
      return 'held'
    }
    if (!this.hasRoomAhead(v)) {
      v.state = 'waiting'
      return 'held'
    }
    const lane = this.lanes.get(laneKey(current))!
    lane.splice(lane.indexOf(v), 1)
    if (lane.length === 0) this.lanes.delete(laneKey(current))
    v.stepIndex++
    v.progress = 0
    v.state = 'moving'
    this.laneFor(next).push(v)
    return 'moved'
  }

  private remainingValid(v: MutableVehicle): boolean {
    if (v.stepIndex + 1 >= v.steps.length) return false
    for (let i = v.stepIndex + 1; i < v.steps.length; i++) {
      const s = v.steps[i]!
      const edge = this.graph.getEdge(s.edge)
      if (!edge || edge.blocked) return false
      if (!((edge.a === s.from && edge.b === s.to) || (edge.b === s.from && edge.a === s.to))) return false
    }
    return true
  }

  /** Rebuilds the junction boxes when the road graph has changed. */
  private refreshJunctions(): void {
    if (this.junctionsVersion === this.graph.version) return
    this.junctionsVersion = this.graph.version
    const degree = (n: NodeId) => this.graph.edgesAt(n).length
    const parent = new Map<NodeId, NodeId>()
    const find = (n: NodeId): NodeId => {
      let r = n
      while (parent.get(r) !== r) r = parent.get(r)!
      parent.set(n, r)
      return r
    }
    const union = (a: NodeId, b: NodeId) => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb))
    }
    // Junctions: 3+ roads, or a tunnel that 2+ roads merge into.
    const portals = new Set(this.portals)
    const intersections = this.graph
      .nodes()
      .filter((n) => degree(n.id) >= 3 || (portals.has(n.id) && degree(n.id) >= 2))
      .map((n) => n.id)
    for (const n of intersections) parent.set(n, n)
    // Too close to clear one junction and stop before the next.
    const threshold = 2 * this.stopDistance + this.geometry.vehicleLength / 2
    const internal = new Set<number>()
    for (const start of intersections) {
      for (const first of this.graph.edgesAt(start)) {
        const chain = [first.id]
        let dist = first.length
        let prev = start
        let node = this.graph.otherEnd(first, start)
        while (degree(node) === 2 && !portals.has(node) && dist < threshold) {
          const nextEdge = this.graph.edgesAt(node).find((e) => e.id !== chain[chain.length - 1])!
          chain.push(nextEdge.id)
          dist += nextEdge.length
          prev = node
          node = this.graph.otherEnd(nextEdge, prev)
        }
        if (node !== start && this.junctionKeysHas(node, degree, portals) && dist < threshold) {
          union(start, node)
          for (const id of chain) internal.add(id)
        }
      }
    }
    this.junctionKeys = new Map(intersections.map((n) => [n, find(n)]))
    this.internalEdges = internal
    // Re-key held boxes and timers for the new grouping.
    const holders = [...this.junctionHolder.values()]
    this.junctionHolder.clear()
    for (const id of holders) {
      const v = this.fleet.get(id)
      if (!v || v.holding === undefined) continue
      const key = this.junctionKeys.get(v.holding)
      if (key === undefined || this.junctionHolder.has(key)) v.holding = undefined
      else this.junctionHolder.set((v.holding = key), id)
    }
    const timers = [...this.junctionFreeAt]
    this.junctionFreeAt.clear()
    for (const [node, at] of timers) {
      const key = this.junctionKeys.get(node)
      if (key !== undefined) this.junctionFreeAt.set(key, Math.max(at, this.junctionFreeAt.get(key) ?? 0))
    }
  }

  private junctionKeysHas(node: NodeId, degree: (n: NodeId) => number, portals: ReadonlySet<NodeId>): boolean {
    return degree(node) >= 3 || (portals.has(node) && degree(node) >= 2)
  }



  private direction(step: RouteStep): Point {
    const p = this.graph.getNode(step.from)!.position
    const q = this.graph.getNode(step.to)!.position
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1
    return { x: (q.x - p.x) / len, y: (q.y - p.y) / len }
  }

  /**
   * Distance along `v`'s route from the start of `steps[fromIndex]` to the
   * nearest vehicle ahead in any later lane, up to `cap` (Infinity if none).
   */
  private gapAhead(v: MutableVehicle, fromIndex: number, cap: number): number {
    let dist = 0
    for (let k = fromIndex; k < v.steps.length && dist < cap; k++) {
      const step = v.steps[k]!
      const lane = this.lanes.get(laneKey(step))
      const rear = lane?.[lane.length - 1]
      if (rear && rear !== v) return dist + rear.progress
      const edge = this.graph.getEdge(step.edge)
      if (!edge) return Infinity
      dist += edge.length
    }
    return Infinity
  }

  /**
   * How far the front vehicle of a lane may advance on its current edge:
   * not closer than `minGap` to the next vehicle along its route, and not
   * past an intersection's stop line unless it holds the junction box.
   */
  private frontLimit(v: MutableVehicle, length: number): number {
    // Driving to its exit portal: nothing ahead along the route.
    const exiting = v.stepIndex + 1 >= v.steps.length
    let limit = exiting ? Infinity : length + this.gapAhead(v, v.stepIndex + 1, this.minGap) - this.minGap
    const step = v.steps[v.stepIndex]!
    const key = this.junctionKeys.get(step.to)
    if (key !== undefined && this.junctionHolder.get(key) !== v.id) {
      // Inside a box it does not hold (a new road just created the box
      // around it): stay put until it gets the box. Otherwise: stop line.
      limit = Math.min(limit, this.internalEdges.has(step.edge) ? v.progress : length - this.stopDistance)
    }
    return limit
  }

  /** Room to enter the next lane: capacity and following distance. */
  private hasRoomAhead(v: MutableVehicle): boolean {
    const next = v.steps[v.stepIndex + 1]!
    const edge = this.graph.getEdge(next.edge)
    if (!edge || edge.blocked) return false
    const lane = this.lanes.get(laneKey(next))
    if (lane && lane.length >= edge.capacity) return false
    return this.gapAhead(v, v.stepIndex + 1, this.minGap) >= this.minGap - 1e-9
  }

  private updateJunctions(): void {
    // Release: the holder is `stopDistance` past the box's last node (or gone).
    for (const [key, id] of [...this.junctionHolder]) {
      const v = this.fleet.get(id)
      const step = v?.steps[v.stepIndex]
      const inBox =
        !!step &&
        (this.internalEdges.has(step.edge) ||
          this.junctionKeys.get(step.to) === key ||
          (this.junctionKeys.get(step.from) === key && v!.progress < this.stopDistance - 1e-9))
      if (!inBox) {
        this.junctionHolder.delete(key)
        if (v) v.holding = undefined
      }
    }
    // Acquire: front vehicles waiting at a stop line, oldest first.
    const candidates: MutableVehicle[] = []
    for (const lane of this.lanes.values()) {
      const v = lane[0]
      if (!v || v.holding !== undefined) continue
      const step = v.steps[v.stepIndex]!
      if (this.junctionKeys.get(step.to) === undefined) continue
      const edge = this.graph.getEdge(step.edge)!
      if (this.internalEdges.has(step.edge) || v.progress >= edge.length - this.stopDistance - 1e-6) candidates.push(v)
    }
    // Vehicles caught inside a box go first so they can clear it; then oldest first.
    const inside = (v: MutableVehicle) => (this.internalEdges.has(v.steps[v.stepIndex]!.edge) ? 0 : 1)
    candidates.sort((a, b) => inside(a) - inside(b) || a.id - b.id)
    for (const v of candidates) {
      const key = this.junctionKeys.get(v.steps[v.stepIndex]!.to)!
      if (this.junctionHolder.has(key)) continue
      if (this.time < (this.junctionFreeAt.get(key) ?? 0) - 1e-9) continue
      const exiting = v.stepIndex + 1 >= v.steps.length
      if (exiting) {
        // Leaving the map through this tunnel: nothing to make room for.
        this.junctionHolder.set(key, v.id)
        v.holding = key
        if (this.junctionClearSec > 0) this.junctionFreeAt.set(key, this.time + this.junctionClearSec)
        continue
      }
      if (!this.remainingValid(v)) continue
      // Don't block the box: only enter with room to leave it.
      const next = v.steps[v.stepIndex + 1]!
      const nextEdge = this.graph.getEdge(next.edge)
      const nextLane = this.lanes.get(laneKey(next))
      if (!nextEdge || nextEdge.blocked || (nextLane && nextLane.length >= nextEdge.capacity)) continue
      if (this.gapAhead(v, v.stepIndex + 1, this.minGap + this.stopDistance) < this.minGap + this.stopDistance - 1e-9) continue
      this.junctionHolder.set(key, v.id)
      v.holding = key
      if (this.junctionClearSec > 0) this.junctionFreeAt.set(key, this.time + this.junctionClearSec)
    }
  }

  private hasRoomAtEntry(step: RouteStep): boolean {
    const edge = this.graph.getEdge(step.edge)
    if (!edge || edge.blocked) return false
    const lane = this.lanes.get(laneKey(step))
    if (!lane || lane.length === 0) return true
    return lane.length < edge.capacity && lane[lane.length - 1]!.progress >= this.minGap - 1e-9
  }

  /**
   * Tries portals starting from a random one, so one blocked tunnel does not
   * stop traffic entering elsewhere. Returns 'blocked' only if every portal's
   * entry lane is full.
   */
  private trySpawn(): 'spawned' | 'blocked' | 'unroutable' {
    const count = this.portals.length
    if (count < 2) return 'unroutable'
    const start = Math.floor(this.random.next() * count)
    for (let k = 0; k < count; k++) {
      const origin = this.portals[(start + k) % count]!
      const others = this.portals.filter((p) => p !== origin)
      const destination = others[Math.floor(this.random.next() * others.length)]!
      const result = findRoute(this.graph, origin, destination)
      if (!result.ok || result.route.steps.length === 0) return 'unroutable'
      if (this.hasRoomAtEntry(result.route.steps[0]!) && this.portalClear(origin)) {
        this.spawnVehicle(origin, destination, result.route.steps)
        return 'spawned'
      }
    }
    return 'blocked'
  }

  /**
   * A new vehicle appears on the portal node itself. On a plain dead-end
   * tunnel (one road) the entry-lane check is enough, because arriving
   * traffic uses the other lane. Where a road continues through or turns at
   * the portal, no vehicle may be within `minGap` of the node in any lane,
   * and at an intersection the junction box must be free (the new vehicle
   * then holds it until it is clear).
   */
  private portalClear(node: NodeId): boolean {
    const edges = this.graph.edgesAt(node)
    if (edges.length <= 1) return true
    this.refreshJunctions()
    const key = this.junctionKeys.get(node)
    if (key !== undefined) {
      if (this.junctionHolder.has(key)) return false
      if (this.time < (this.junctionFreeAt.get(key) ?? 0) - 1e-9) return false
    }
    for (const edge of edges) {
      const other = this.graph.otherEnd(edge, node)
      const leaving = this.lanes.get(`${edge.id}>${node}`)
      const rear = leaving?.[leaving.length - 1]
      if (rear && rear.progress < this.minGap) return false
      const arriving = this.lanes.get(`${edge.id}>${other}`)
      const front = arriving?.[0]
      if (front && edge.length - front.progress < this.minGap) return false
    }
    return true
  }

  private spawnVehicle(origin: NodeId, destination: NodeId, route: readonly RouteStep[]): void {
    const v: MutableVehicle = {
      id: this.nextId++,
      origin,
      destination,
      steps: [...route],
      stepIndex: 0,
      progress: 0,
      speed: 0,
      state: 'moving',
      waitTime: 0,
      waitingFor: 0,
      spawnedAt: this.time,
      routeVersion: this.graph.version,
      failedVersion: -1,
      holding: undefined,
    }
    this.fleet.set(v.id, v)
    this.laneFor(route[0]!).push(v)
    const key = this.junctionKeys.get(origin)
    if (key !== undefined) {
      this.junctionHolder.set(key, v.id)
      v.holding = key
      if (this.junctionClearSec > 0) this.junctionFreeAt.set(key, this.time + this.junctionClearSec)
    }
    this.totalSpawned++
  }

  private removeVehicle(v: MutableVehicle, step: RouteStep): void {
    const lane = this.lanes.get(laneKey(step))!
    lane.splice(lane.indexOf(v), 1)
    if (lane.length === 0) this.lanes.delete(laneKey(step))
    this.fleet.delete(v.id)
    if (v.holding !== undefined && this.junctionHolder.get(v.holding) === v.id) this.junctionHolder.delete(v.holding)
  }

  private laneFor(step: RouteStep): MutableVehicle[] {
    const key = laneKey(step)
    let lane = this.lanes.get(key)
    if (!lane) this.lanes.set(key, (lane = []))
    return lane
  }
}

/**
 * Offset from a node to the lane centre for traffic arriving in direction
 * `a` and leaving in direction `b` (unit vectors), on the right-hand side.
 * With both directions it is the mitre of the two offset lines, so lanes
 * meet exactly; very sharp turns fall back to the outgoing offset.
 */
export function miterOffset(a: Point | undefined, b: Point | undefined, d: number): Point {
  const right = (u: Point): Point => ({ x: -u.y, y: u.x })
  if (!a && !b) return { x: 0, y: 0 }
  if (!a || !b) {
    const n = right((a ?? b)!)
    return { x: n.x * d, y: n.y * d }
  }
  const na = right(a)
  const nb = right(b)
  const denom = 1 + na.x * nb.x + na.y * nb.y
  if (denom < 0.25) return { x: nb.x * d, y: nb.y * d }
  return { x: ((na.x + nb.x) * d) / denom, y: ((na.y + nb.y) * d) / denom }
}
