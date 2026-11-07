/**
 * Deterministic traffic simulation (#5).
 *
 * Vehicles enter at tunnel portals, follow shortest-time routes over the
 * RoadGraph, queue behind each other and leave at their destination portal.
 *
 * Model (discrete, no physics):
 * - Each edge has one lane per direction. A lane holds vehicles ordered
 *   front-first; vehicles never overtake.
 * - A vehicle cruises at its class's share of the edge's speed limit, but
 *   never closer than `minGap` tiles to the vehicle ahead in its lane. It
 *   accelerates and brakes at its class's rates (#31, `nextSpeed`), never
 *   faster than lets it stop before that hard limit, so braking spreads back
 *   along queues while vehicles still never overlap.
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
 *   `stopDistance` before the node (further back where roads meet at a sharp
 *   angle, or at a bend sharper than a right angle, which also counts as a
 *   junction) and a junction box: one vehicle at a time
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
import {
  VEHICLE_SPACING,
  findRoute,
  type EdgeMerge,
  type EdgeSplit,
  type Point,
  type NodeId,
  type RemovalResult,
  type RoadEdge,
  type RoadGraph,
  type RouteStep,
} from '../roads'
import {
  defaultPhases,
  describeJunction,
  DEFAULT_SIGNAL_GREEN_SEC,
  lightFor,
  normalizeAngle,
  orderByRightOfWay,
  signalPhaseAt,
  SIGNAL_CLEARANCE_SEC,
  type Junction,
  type JunctionLane,
  type SignalLight,
  type SignalOptions,
} from './junctions'

/** Structural subset of the world Rng: uniform float in [0, 1). */
export interface RandomSource {
  next(): number
}

export type VehicleClass = 'car' | 'van' | 'truck'

/** Simulation-space vehicle profiles. Width stays inside one lane. */
export interface VehicleProfile {
  readonly length: number
  readonly width: number
  /** Share of the road's speed limit this class cruises at. */
  readonly speedFactor: number
  /** Acceleration from rest or after slowing, in tiles/s². */
  readonly accel: number
  /** Comfortable braking, in tiles/s², used to slow down ahead of a stop (#31). */
  readonly decel: number
}

/**
 * Simulation-space vehicle profiles. Width stays inside one lane. Heavier
 * classes accelerate and brake more gently, so they start later from a
 * queue and begin slowing further back.
 */
export const VEHICLE_PROFILES: Readonly<Record<VehicleClass, VehicleProfile>> = Object.freeze({
  car: Object.freeze({ length: 0.5, width: 0.22, speedFactor: 1, accel: 4, decel: 6 }),
  van: Object.freeze({ length: 0.68, width: 0.24, speedFactor: 0.88, accel: 3.2, decel: 5 }),
  truck: Object.freeze({ length: 0.9, width: 0.26, speedFactor: 0.72, accel: 2.2, decel: 4 }),
})

/**
 * Speed for the next step (#31): accelerate toward `cruise`, but never faster
 * than allows braking at `decel` to a stop within `room` (the distance to the
 * hard limit ahead), and never past that limit within this step. Because
 * the limit itself is hard, vehicles never overlap even if a leader stops
 * more sharply than `decel`.
 */
export function nextSpeed(speed: number, cruise: number, room: number, accel: number, decel: number, dt: number): number {
  if (!(room > 0)) return 0
  return Math.max(0, Math.min(speed + accel * dt, cruise, Math.sqrt(2 * decel * room), room / dt))
}

export type VehicleMix = Readonly<Record<VehicleClass, number>>

export const DEFAULT_VEHICLE_MIX: VehicleMix = Object.freeze({ car: 1, van: 0, truck: 0 })

/** Conservative mixed-traffic gap: safe even when a truck follows another truck. */
export function mixedVehicleGeometry(g: RoadGeometry = ROAD_GEOMETRY): RoadGeometry {
  return { ...g, vehicleLength: Math.max(...Object.values(VEHICLE_PROFILES).map((profile) => profile.length)) }
}

export function vehicleFollowingGap(follower: VehicleClass, leader: VehicleClass, g: RoadGeometry = ROAD_GEOMETRY): number {
  const a = VEHICLE_PROFILES[follower]
  const b = VEHICLE_PROFILES[leader]
  return (a.length + b.length) / 2 +
    2 * (laneOffset(g) + Math.max(a.width, b.width) / 2 + g.safetyGap)
}

export function mixedVehicleMinGap(g: RoadGeometry = ROAD_GEOMETRY): number {
  return Math.max(...Object.values(VEHICLE_PROFILES).map((profile) =>
    profile.length + 2 * (laneOffset(g) + profile.width / 2 + g.safetyGap),
  ))
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
  /**
   * Clear time at a roundabout as a share of `junctionClearSec` (shop item):
   * traffic gives way and merges instead of stopping, so it turns over faster.
   */
  readonly roundaboutClearFactor?: number
  /** Clear time at a signalled junction as a share of `junctionClearSec`. */
  readonly signalClearFactor?: number
  /** Two-lane road and vehicle dimensions (defaults to ROAD_GEOMETRY). */
  readonly geometry?: RoadGeometry
  /** Relative spawn weights; normalized internally. */
  readonly vehicleMix?: Partial<VehicleMix>
}

export type VehicleState = 'moving' | 'waiting' | 'stuck'

export interface Vehicle {
  readonly id: number
  readonly kind: VehicleClass
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

/** A placed traffic signal and what it currently shows (#32). */
export interface SignalView {
  /** The node the signal was placed on. */
  readonly node: NodeId
  readonly junction: Junction
  readonly greenSec: number
  readonly clearanceSec: number
  /** Approach indices per phase. */
  readonly phases: readonly (readonly number[])[]
  readonly phase: number
  readonly clearance: boolean
  /** Seconds until the current green or clearance ends. */
  readonly remaining: number
  /** Light per approach, in `junction.approaches` order. */
  readonly lights: readonly SignalLight[]
}

/** What a vehicle will do at the end of its current road (#32). */
export interface VehicleIntent {
  readonly turn: 'left' | 'right' | 'straight' | 'exit'
  /** Distance to the end of the current road, in tiles. */
  readonly distance: number
  /** Whether that end is a junction box. */
  readonly junction: boolean
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
  kind: VehicleClass
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
/** Default roundabout clear time as a share of the junction clear time. */
export const DEFAULT_ROUNDABOUT_CLEAR_FACTOR = 0.35

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
  readonly roundaboutClearFactor: number
  readonly signalClearFactor: number
  readonly geometry: RoadGeometry
  private vehicleMix: VehicleMix
  /** Distance before a right-angle (or wider) intersection where vehicles stop (vehicle centre). */
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
  /**
   * Stop distance per `edge:node` end where it differs from `stopDistance`:
   * roads may meet at any angle, and sharper joins need the stop line (and
   * the box's exit) further from the node.
   */
  private stopDistances = new Map<string, number>()
  private junctionsVersion = -1
  /** Junction key -> described junction (approaches, exits, movements). */
  private junctionInfo = new Map<NodeId, Junction>()
  /** Placed signals by the node they were placed on (#32). */
  private readonly signalMap = new Map<NodeId, { greenSec: number; startedAt: number }>()
  /** Nodes roundabouts were placed on (anchors, like signals). */
  private readonly roundaboutSet = new Set<NodeId>()
  /** Vehicle id -> box key and time it started waiting for that box (right-of-way). */
  private readonly arrivals = new Map<number, { key: NodeId; at: number }>()

  constructor(graph: RoadGraph, options: TrafficOptions) {
    this.graph = graph
    this.portals = [...options.portals]
    for (const p of this.portals) if (!graph.hasNode(p)) throw new Error(`portal node ${p} is not in the graph`)
    this.random = options.random
    this.maxVehicles = options.maxVehicles ?? DEFAULT_CONFIG.maxVehicles
    this.spawnInterval = options.spawnIntervalSec ?? DEFAULT_CONFIG.initialSpawnIntervalSec
    this.minSpawnIntervalSec = options.minSpawnIntervalSec ?? DEFAULT_CONFIG.minSpawnIntervalSec
    this.geometry = options.geometry ?? ROAD_GEOMETRY
    this.vehicleMix = normalizeVehicleMix(options.vehicleMix)
    this.minGap = options.minGap ?? Math.max(VEHICLE_SPACING, minFollowingDistance(this.geometry))
    this.junctionClearSec = options.junctionClearSec ?? DEFAULT_JUNCTION_CLEAR_SEC
    this.roundaboutClearFactor = options.roundaboutClearFactor ?? DEFAULT_ROUNDABOUT_CLEAR_FACTOR
    this.signalClearFactor = options.signalClearFactor ?? 1
    for (const f of [this.roundaboutClearFactor, this.signalClearFactor]) {
      if (!(f >= 0) || !Number.isFinite(f)) throw new RangeError('clear factors must be non-negative')
    }
    this.maxPendingSpawns = options.maxPendingSpawns ?? this.maxVehicles
    this.pending = Math.min(options.startingVehicles ?? DEFAULT_CONFIG.startingVehicles, this.maxPendingSpawns)
    if (!(this.minGap > 0)) throw new RangeError('minGap must be positive')
    validateRoadGeometry(this.geometry, this.minGap)
    this.stopDistance = junctionStopDistance(this.geometry)
    this.setSpawnInterval(this.spawnInterval)
  }

  /** Updates the deterministic weighted vehicle mix for subsequent spawns. */
  setVehicleMix(mix: Partial<VehicleMix>): void {
    this.vehicleMix = normalizeVehicleMix(mix)
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

  /** Every junction box with its approaches, exits and movements (#32). */
  junctions(): readonly Junction[] {
    this.refreshJunctions()
    return [...this.junctionInfo.values()]
  }

  /** The junction box containing `node`, if it is one. */
  junctionAt(node: NodeId): Junction | undefined {
    this.refreshJunctions()
    const key = this.junctionKeys.get(node)
    return key === undefined ? undefined : this.junctionInfo.get(key)
  }

  /** Whether a junction can take traffic signals: not a tunnel, three or more approaches. */
  isSignalJunction(junction: Junction): boolean {
    return !junction.portal && junction.approaches.length >= 3
  }

  /** Nearest junction that can take signals, with its centre within `maxDistance` tiles of `point`. */
  signalJunctionNear(point: Point, maxDistance: number): Junction | undefined {
    let best: { j: Junction; d: number } | undefined
    for (const j of this.junctions()) {
      if (!this.isSignalJunction(j)) continue
      const d = Math.hypot(j.center.x - point.x, j.center.y - point.y)
      if (d <= maxDistance && (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && j.key < best.j.key))) best = { j, d }
    }
    return best?.j
  }

  /**
   * Places a fixed-time traffic signal on the junction containing `node`
   * (#32), or reconfigures the one already there. Its cycle starts now with
   * the first phase green. Returns false if that junction cannot take signals.
   */
  placeSignal(node: NodeId, options: SignalOptions = {}): boolean {
    const junction = this.junctionAt(node)
    if (!junction || !this.isSignalJunction(junction)) return false
    if (this.roundaboutAnchor(junction.key) !== undefined) return false
    const greenSec = options.greenSec ?? DEFAULT_SIGNAL_GREEN_SEC
    if (!(greenSec > 0) || !Number.isFinite(greenSec)) throw new RangeError('greenSec must be positive')
    const existing = this.signalAnchor(junction.key)
    if (existing !== undefined) this.signalMap.get(existing)!.greenSec = greenSec
    else this.signalMap.set(node, { greenSec, startedAt: this.time })
    return true
  }

  /** Removes the signal on the junction containing `node`. Returns whether there was one. */
  removeSignal(node: NodeId): boolean {
    const key = this.junctionKeys.get(node)
    const anchor = key === undefined ? (this.signalMap.has(node) ? node : undefined) : this.signalAnchor(key)
    return anchor !== undefined && this.signalMap.delete(anchor)
  }

  /** The signal on the junction containing `node`, if any. */
  signalAt(node: NodeId): SignalView | undefined {
    this.refreshJunctions()
    const key = this.junctionKeys.get(node)
    const anchor = key === undefined ? undefined : this.signalAnchor(key)
    return anchor === undefined ? undefined : this.signalView(anchor)
  }

  /**
   * All active signals. A signal whose junction stopped being one (the
   * graph changed) is kept but inactive until it is a junction again.
   */
  signals(): readonly SignalView[] {
    this.refreshJunctions()
    const views: SignalView[] = []
    const seen = new Set<NodeId>()
    for (const anchor of [...this.signalMap.keys()].sort((a, b) => a - b)) {
      const key = this.junctionKeys.get(anchor)
      if (key === undefined || seen.has(key)) continue
      seen.add(key)
      const view = this.signalView(anchor)
      if (view) views.push(view)
    }
    return views
  }

  /**
   * Builds a roundabout on the junction containing `node` (shop item).
   * Vehicles keep the one-at-a-time box, but it frees up after
   * `junctionClearSec × roundaboutClearFactor`, so a busy junction carries
   * far more traffic. Returns false if the junction cannot take one, or has
   * traffic lights (remove those first). Placing it again is a no-op (true).
   */
  placeRoundabout(node: NodeId): boolean {
    const junction = this.junctionAt(node)
    if (!junction || !this.isSignalJunction(junction)) return false
    if (this.signalAnchor(junction.key) !== undefined) return false
    if (this.roundaboutAnchor(junction.key) === undefined) this.roundaboutSet.add(node)
    return true
  }

  /** Removes the roundabout on the junction containing `node`. Returns whether there was one. */
  removeRoundabout(node: NodeId): boolean {
    this.refreshJunctions()
    const key = this.junctionKeys.get(node)
    const anchor = key === undefined ? (this.roundaboutSet.has(node) ? node : undefined) : this.roundaboutAnchor(key)
    return anchor !== undefined && this.roundaboutSet.delete(anchor)
  }

  /** The junction with a roundabout containing `node`, if any. */
  roundaboutAt(node: NodeId): Junction | undefined {
    this.refreshJunctions()
    const key = this.junctionKeys.get(node)
    if (key === undefined || this.roundaboutAnchor(key) === undefined) return undefined
    const junction = this.junctionInfo.get(key)
    return junction && this.isSignalJunction(junction) ? junction : undefined
  }

  /** Junctions with an active roundabout, by key. */
  roundabouts(): readonly Junction[] {
    this.refreshJunctions()
    const out = new Map<NodeId, Junction>()
    for (const anchor of this.roundaboutSet) {
      const j = this.roundaboutAt(anchor)
      if (j) out.set(j.key, j)
    }
    return [...out.values()].sort((a, b) => a.key - b.key)
  }

  /** Seconds box `key` stays closed to the next vehicle after one enters. */
  private clearSecFor(key: NodeId): number {
    if (this.roundaboutSet.size > 0 && this.roundaboutAnchor(key) !== undefined) {
      const j = this.junctionInfo.get(key)
      if (j && this.isSignalJunction(j)) return this.junctionClearSec * this.roundaboutClearFactor
    }
    if (this.signalClearFactor !== 1 && this.signalMap.size > 0) {
      const anchor = this.signalAnchor(key)
      if (anchor !== undefined && this.signalView(anchor)) return this.junctionClearSec * this.signalClearFactor
    }
    return this.junctionClearSec
  }

  private roundaboutAnchor(key: NodeId): NodeId | undefined {
    let best: NodeId | undefined
    for (const anchor of this.roundaboutSet) {
      if (this.junctionKeys.get(anchor) === key && (best === undefined || anchor < best)) best = anchor
    }
    return best
  }

  /** What `vehicle` will do where its current road ends (for turn indicators). */
  intentOf(vehicle: Vehicle): VehicleIntent {
    this.refreshJunctions()
    const step = vehicle.steps[vehicle.stepIndex]!
    const edge = this.graph.getEdge(step.edge)
    const distance = Math.max(0, (edge?.length ?? 0) - vehicle.progress)
    const junction = this.junctionKeys.has(step.to)
    const next = vehicle.steps[vehicle.stepIndex + 1]
    if (!next) return { turn: 'exit', distance, junction }
    const diff = normalizeAngle(this.headingOf(next) - this.headingOf(step))
    const turn = Math.abs(diff) < Math.PI / 6 ? 'straight' : diff > 0 ? 'right' : 'left'
    return { turn, distance, junction }
  }

  /**
   * Whether `v` would touch any other vehicle while traversing junction box
   * `key` and clearing its exit. Check the entire approach and departure
   * traffic, not only vehicles stranded inside the box: a turning vehicle's
   * swept path can reach a queue before its nominal stop line, especially
   * after a player-built sharp road changes the junction geometry.
   *
   * Vehicle footprints include the configured safety gap. Sampling every
   * 0.05 tiles keeps the check conservative without depending on render rate.
   */
  /**
   * 0: stranded on a road inside a junction box; 1: stranded past a stop
   * line a new road moved back; 2: not stranded (before its stop line, or
   * not heading into a box).
   */
  private strandTier(v: MutableVehicle): number {
    const step = v.steps[v.stepIndex]!
    if (this.junctionKeys.get(step.to) === undefined) return 2
    if (this.internalEdges.has(step.edge)) return 0
    const edge = this.graph.getEdge(step.edge)!
    return v.progress > edge.length - this.stopDistanceAt(step.edge, step.to) + 1e-6 ? 1 : 2
  }

  private sweepHitsStranded(v: MutableVehicle, key: NodeId, tier: (o: MutableVehicle) => number = (o) => this.strandTier(o)): boolean {
    const others: Corner[][] = []
    for (const o of this.fleet.values()) {
      if (o === v || o.holding !== undefined || this.junctionKeys.get(o.steps[o.stepIndex]!.to) !== key || tier(o) >= 2) continue
      others.push(this.footprintAt(o, o.stepIndex, o.progress))
    }
    // Two vehicles already touching (a new road merged their boxes around
    // both) can only separate by moving: that overlap is not this sweep's.
    const start = this.footprintAt(v, v.stepIndex, v.progress)
    const clearOfStart = others.filter((o) => !rectanglesOverlap(start, o))
    if (clearOfStart.length === 0) return false
    others.length = 0
    others.push(...clearOfStart)
    let i = v.stepIndex
    let progress = v.progress
    for (let guard = 0; guard < 2000; guard++) {
      const step = v.steps[i]!
      const length = this.graph.getEdge(step.edge)!.length
      const inBox = this.internalEdges.has(step.edge) || this.junctionKeys.get(step.to) === key
      // Past the box: stop once the vehicle would release it.
      const leaving = this.junctionKeys.get(step.from) === key && !inBox
      if (leaving && progress >= this.stopDistanceAt(step.edge, step.from) + VEHICLE_PROFILES[v.kind].length / 2) return false
      if (!inBox && !leaving) return false
      const mine = this.footprintAt(v, i, progress)
      if (others.some((o) => rectanglesOverlap(mine, o))) return true
      progress += 0.05
      if (progress > length) {
        if (i + 1 >= v.steps.length) return false
        progress -= length
        i++
      }
    }
    return false
  }

private footprintAt(v: MutableVehicle, stepIndex: number, progress: number, safetyMargin = this.geometry.safetyGap / 2): Corner[] {
    const { position: p, heading: h } = this.lanePositionOf({ ...v, stepIndex, progress })
    const profile = VEHICLE_PROFILES[v.kind]
    const L = profile.length / 2 + safetyMargin
    const W = profile.width / 2 + safetyMargin
    const c = Math.cos(h)
    const sn = Math.sin(h)
    return [
      [L, W],
      [-L, W],
      [-L, -W],
      [L, -W],
    ].map(([a, b]) => [p.x + a! * c - b! * sn, p.y + a! * sn + b! * c] as const)
  }

  /** Lowest-anchored signal on box `key`. */
  private signalAnchor(key: NodeId): NodeId | undefined {
    let best: NodeId | undefined
    for (const anchor of this.signalMap.keys()) {
      if (this.junctionKeys.get(anchor) === key && (best === undefined || anchor < best)) best = anchor
    }
    return best
  }

  private signalView(anchor: NodeId): SignalView | undefined {
    const signal = this.signalMap.get(anchor)
    const key = this.junctionKeys.get(anchor)
    const junction = key === undefined ? undefined : this.junctionInfo.get(key)
    if (!signal || !junction || !this.isSignalJunction(junction)) return undefined
    const phases = defaultPhases(junction.approaches)
    const state = signalPhaseAt(phases.length, signal.greenSec, this.time - signal.startedAt, SIGNAL_CLEARANCE_SEC)
    return {
      node: anchor,
      junction,
      greenSec: signal.greenSec,
      clearanceSec: SIGNAL_CLEARANCE_SEC,
      phases,
      phase: state.phase,
      clearance: state.clearance,
      remaining: state.remaining,
      lights: junction.approaches.map((_, i) => lightFor(phases, i, state)),
    }
  }

  /** Light shown to a vehicle driving `step` toward a signalled box, if any. */
  private lightAt(step: RouteStep): SignalLight | undefined {
    if (this.signalMap.size === 0) return undefined
    const key = this.junctionKeys.get(step.to)
    const anchor = key === undefined ? undefined : this.signalAnchor(key)
    if (anchor === undefined) return undefined
    const view = this.signalView(anchor)
    if (!view) return undefined
    const index = view.junction.approaches.findIndex((a: JunctionLane) => a.edge === step.edge && a.node === step.to)
    return index < 0 ? undefined : view.lights[index]
  }

  private headingOf(step: RouteStep): number {
    const d = this.direction(step)
    return Math.atan2(d.y, d.x)
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
    this.updateJunctions(dt)

    // 1. Movement within lanes, front to back.
    const atEnd: MutableVehicle[] = []
    for (const lane of this.lanes.values()) {
      let limit = Infinity
      let leader: MutableVehicle | undefined
      for (const v of lane) {
        const step = v.steps[v.stepIndex]!
        const edge = this.graph.getEdge(step.edge)!
        // Followers respect stop lines too: at a sharp join the stop line can
        // lie further back than the following distance behind a box holder.
        limit = leader === undefined ? this.frontLimit(v, edge.length) : Math.min(limit, this.stopLineLimit(v, edge.length), leader.progress - this.followingGap(v, leader))
        // Smooth following (#31): the speed persists between steps and the
        // vehicle brakes ahead of the hard limit (leader, stop line or the
        // end of its edge when it cannot enter the next lane).
        const profile = VEHICLE_PROFILES[v.kind]
        const room = Math.min(edge.length + (leader === undefined ? this.roomBeyondEdge(v, limit, edge.length) : 0), limit) - v.progress
        const speed = nextSpeed(v.speed, edge.speedLimit * profile.speedFactor, room, profile.accel, profile.decel, dt)
        const target = Math.min(edge.length, limit, v.progress + speed * dt)
        const moved = Math.max(0, target - v.progress)
        v.progress += moved
        v.speed = moved / dt
        v.state = moved > 1e-9 ? 'moving' : v.state === 'stuck' ? 'stuck' : 'waiting'
        if (v.progress >= edge.length - 1e-9) atEnd.push(v)
        leader = v
        limit = Infinity
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
    // Uses only the split record, not the graph: when several splits are
    // replayed in order, a later one may already have retired these halves.
    const { a, b, towardA, towardB, towardALength, towardBLength } = split
    const expand = (step: RouteStep): RouteStep[] =>
      step.from === a
        ? [
            { edge: towardA, from: a, to: split.node },
            { edge: towardB, from: split.node, to: b },
          ]
        : [
            { edge: towardB, from: b, to: split.node },
            { edge: towardA, from: split.node, to: a },
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
          const firstLength = s.from === a ? towardALength : towardBLength
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

    // A box holder must not sweep a vehicle a new road stranded in its box
    // (re-planning onto that road can send it there). Prefer the route it
    // claimed the box for; if that is not clear either, give the box up: it
    // is then stranded itself, and the stranded vehicles' sweep checks
    // decide who moves first.
    const claimed = v.steps
    this.replanIfStale(v)
    if (v.holding !== undefined && this.sweepHitsStranded(v, v.holding)) {
      const replanned = v.steps
      v.steps = claimed
      if (replanned === claimed || !this.remainingValid(v) || this.sweepHitsStranded(v, v.holding)) {
        v.steps = replanned
        if (this.junctionHolder.get(v.holding) === v.id) this.junctionHolder.delete(v.holding)
        v.holding = undefined
        v.state = 'waiting'
        return 'held'
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

  /**
   * Re-plans from the end of the current road if the graph changed since the
   * route was made. Called at the junction, and before claiming a junction
   * box so the box is claimed for the route actually driven.
   */
  private replanIfStale(v: MutableVehicle): void {
    if (v.routeVersion === this.graph.version || v.failedVersion === this.graph.version) return
    const node = v.steps[v.stepIndex]!.to
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

  /**
   * Whether `edge` is closed to `v`. Blocked edges are closed, except that a
   * vehicle already on a closing player road (#33) may drive on along that
   * road's other blocked edges to leave it.
   */
  private closedTo(v: MutableVehicle, edge: RoadEdge): boolean {
    if (!edge.blocked) return false
    const current = this.graph.getEdge(v.steps[v.stepIndex]!.edge)
    return !(current?.blocked && current.road !== undefined && current.road === edge.road)
  }

  /**
   * Migrates vehicles after `RoadGraph.removeEdges` (#33). No vehicle may be
   * on a removed edge (callers wait until the road is clear). Vehicles on
   * two merged halves move onto the merged edge at the same world position;
   * routes through removed edges are re-planned from the end of the current
   * road (or left to stop there, `stuck`, if no route remains).
   */
  applyRemoval(result: RemovalResult): void {
    for (const merge of result.merges) this.applyMerge(merge)
    const removed = new Set(result.removedEdges)
    for (const v of this.fleet.values()) {
      if (removed.has(v.steps[v.stepIndex]!.edge)) throw new Error(`vehicle ${v.id} is on removed edge ${v.steps[v.stepIndex]!.edge}`)
      // Forget the part of the route already driven if it used a removed edge.
      if (v.steps.slice(0, v.stepIndex).some((s) => removed.has(s.edge))) {
        v.steps = v.steps.slice(v.stepIndex)
        v.stepIndex = 0
      }
      if (!v.steps.slice(v.stepIndex + 1).some((s) => removed.has(s.edge))) continue
      const at = v.steps[v.stepIndex]!.to
      const route = at === v.destination ? undefined : findRoute(this.graph, at, v.destination)
      v.steps = [...v.steps.slice(0, v.stepIndex + 1), ...(route?.ok ? route.route.steps : [])]
      v.routeVersion = this.graph.version
      if (!route?.ok && at !== v.destination) v.failedVersion = this.graph.version
    }
  }

  /** Inverse of applySplit: vehicles on either half move onto the merged edge in place. */
  applyMerge(merge: EdgeMerge): void {
    const { a, b, node, fromA, fromB, merged, fromALength, fromBLength } = merge
    const isHalf = (s: RouteStep) => s.edge === fromA || s.edge === fromB
    const towardB = (s: RouteStep) => (s.edge === fromA ? s.from === a : s.from === node)
    for (const v of this.fleet.values()) {
      const steps: RouteStep[] = []
      let stepIndex = v.stepIndex
      let progress = v.progress
      for (let i = 0; i < v.steps.length; i++) {
        const s = v.steps[i]!
        if (!isHalf(s)) {
          if (i === v.stepIndex) stepIndex = steps.length
          steps.push(s)
          continue
        }
        const forward = towardB(s)
        const step: RouteStep = forward ? { edge: merged, from: a, to: b } : { edge: merged, from: b, to: a }
        // Offset of this half's start along the merged step.
        const offset = (forward ? s.edge === fromB : s.edge === fromA) ? (forward ? fromALength : fromBLength) : 0
        const next = v.steps[i + 1]
        const pairs = next !== undefined && isHalf(next) && towardB(next) === forward
        if (i === v.stepIndex || (pairs && i + 1 === v.stepIndex)) {
          stepIndex = steps.length
          progress = i === v.stepIndex ? offset + v.progress : (forward ? fromALength : fromBLength) + v.progress
        }
        steps.push(step)
        if (pairs) i++
      }
      v.steps = steps
      v.stepIndex = stepIndex
      v.progress = progress
    }
    for (const key of [`${fromA}>${a}`, `${fromA}>${node}`, `${fromB}>${node}`, `${fromB}>${b}`]) {
      const lane = this.lanes.get(key)
      if (!lane) continue
      this.lanes.delete(key)
      for (const v of lane) this.laneFor(v.steps[v.stepIndex]!).push(v)
    }
    for (const lane of this.lanes.values()) lane.sort((x, y) => y.progress - x.progress || x.id - y.id)
  }

  private remainingValid(v: MutableVehicle): boolean {
    if (v.stepIndex + 1 >= v.steps.length) return false
    for (let i = v.stepIndex + 1; i < v.steps.length; i++) {
      const s = v.steps[i]!
      const edge = this.graph.getEdge(s.edge)
      if (!edge || this.closedTo(v, edge)) return false
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
    // Sharpest angle between each road end and the other roads at its node.
    const stops = new Map<string, number>()
    const sharpest = new Map<NodeId, number>()
    for (const n of this.graph.nodes()) {
      const edges = this.graph.edgesAt(n.id)
      const dirs = edges.map((e) => {
        const q = this.graph.getNode(this.graph.otherEnd(e, n.id))!.position
        const len = Math.hypot(q.x - n.position.x, q.y - n.position.y) || 1
        return { x: (q.x - n.position.x) / len, y: (q.y - n.position.y) / len }
      })
      let nodeMin = Math.PI
      edges.forEach((e, i) => {
        let min = Math.PI
        dirs.forEach((d, j) => {
          if (j !== i) min = Math.min(min, Math.acos(Math.max(-1, Math.min(1, d.x * dirs[i]!.x + d.y * dirs[i]!.y))))
        })
        nodeMin = Math.min(nodeMin, min)
        const stop = junctionStopDistance(this.geometry, min)
        if (stop > this.stopDistance + 1e-9) stops.set(`${e.id}:${n.id}`, stop)
      })
      sharpest.set(n.id, nodeMin)
    }
    this.stopDistances = stops
    // Junctions: 3+ roads, a tunnel that 2+ roads merge into, or a bend
    // sharper than a right angle (its two road surfaces overlap).
    const portals = new Set(this.portals)
    const isJunction = (n: NodeId) =>
      degree(n) >= 3 || (degree(n) >= 2 && (portals.has(n) || sharpest.get(n)! < Math.PI / 2 - 1e-6))
    const intersections = this.graph
      .nodes()
      .filter((n) => isJunction(n.id))
      .map((n) => n.id)
    for (const n of intersections) parent.set(n, n)
    // Too close to clear one junction and stop before the next.
    const maxStop = Math.max(this.stopDistance, ...stops.values())
    const internal = new Set<number>()
    for (const start of intersections) {
      for (const first of this.graph.edgesAt(start)) {
        const chain = [first.id]
        let dist = first.length
        let prev = start
        let node = this.graph.otherEnd(first, start)
        const reach = this.stopDistanceAt(first.id, start) + this.geometry.vehicleLength / 2
        while (degree(node) === 2 && !isJunction(node) && dist < reach + maxStop) {
          const nextEdge = this.graph.edgesAt(node).find((e) => e.id !== chain[chain.length - 1])!
          chain.push(nextEdge.id)
          dist += nextEdge.length
          prev = node
          node = this.graph.otherEnd(nextEdge, prev)
        }
        const last = chain[chain.length - 1]!
        if (node !== start && isJunction(node) && dist < reach + this.stopDistanceAt(last, node)) {
          union(start, node)
          for (const id of chain) internal.add(id)
        }
      }
    }
    // A sharp join's stop line can lie beyond the far end of a short road
    // (e.g. past a bend of a freehand road). The box then extends through
    // that bend: the road becomes internal and the stop line moves onto the
    // next road by the remaining distance.
    const members = [...intersections]
    const queue = [...stops].map(([k, d]) => {
      const [edge, node] = k.split(':').map(Number) as [number, NodeId]
      return { edge, node, d }
    })
    while (queue.length > 0) {
      const { edge: id, node, d } = queue.pop()!
      const edge = this.graph.getEdge(id)!
      if (d <= edge.length || !parent.has(node) || internal.has(id)) continue
      const far = this.graph.otherEnd(edge, node)
      if (degree(far) !== 2 || parent.has(far)) continue
      const next = this.graph.edgesAt(far).find((e) => e.id !== id)!
      parent.set(far, far)
      union(node, far)
      members.push(far)
      internal.add(id)
      const rest = d - edge.length
      const key = `${next.id}:${far}`
      stops.set(key, Math.max(rest, stops.get(key) ?? this.stopDistance))
      queue.push({ edge: next.id, node: far, d: rest })
    }
    this.junctionKeys = new Map(members.map((n) => [n, find(n)]))
    this.internalEdges = internal
    const boxes = new Map<NodeId, NodeId[]>()
    for (const [n, key] of this.junctionKeys) boxes.set(key, [...(boxes.get(key) ?? []), n])
    this.junctionInfo = new Map(
      [...boxes].map(([key, nodes]) => [key, describeJunction(this.graph, key, nodes, internal, nodes.some((n) => portals.has(n)))]),
    )
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

  /** Distance from `node` to the stop line on `edge` (vehicle centre). */
  private stopDistanceAt(edge: number, node: NodeId): number {
    return this.stopDistances.get(`${edge}:${node}`) ?? this.stopDistance
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
  private followingGap(follower: MutableVehicle, leader: MutableVehicle): number {
    return vehicleFollowingGap(follower.kind, leader.kind, this.geometry)
  }

  private gapAhead(v: MutableVehicle, fromIndex: number, cap: number): number {
    let dist = 0
    for (let k = fromIndex; k < v.steps.length && dist < cap; k++) {
      const step = v.steps[k]!
      const lane = this.lanes.get(laneKey(step))
      const rear = lane?.[lane.length - 1]
      if (rear && rear !== v) return dist + rear.progress - this.followingGap(v, rear)
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
    let limit = exiting ? Infinity : length + this.gapAhead(v, v.stepIndex + 1, mixedVehicleMinGap(this.geometry))
    return Math.min(limit, this.stopLineLimit(v, length))
  }

  /**
   * Braking room past the end of the current edge for a lane's front
   * vehicle: none if it cannot enter its next lane (blocked, full, or it is
   * about to wait at a junction it has no route through), otherwise the room
   * its look-ahead limit allows, so it keeps its speed through free nodes.
   */
  private roomBeyondEdge(v: MutableVehicle, limit: number, length: number): number {
    if (v.stepIndex + 1 >= v.steps.length) return Math.max(0, limit - length)
    if (v.state === 'stuck') return 0
    const next = v.steps[v.stepIndex + 1]!
    const edge = this.graph.getEdge(next.edge)
    if (!edge || this.closedTo(v, edge)) return 0
    const lane = this.lanes.get(laneKey(next))
    if (lane && lane.length >= edge.capacity) return 0
    return Math.max(0, limit - length)
  }

  /** How far `v` may advance before the junction box ahead, unless it holds it. */
  private stopLineLimit(v: MutableVehicle, length: number): number {
    const step = v.steps[v.stepIndex]!
    const key = this.junctionKeys.get(step.to)
    if (key === undefined || this.junctionHolder.get(key) === v.id) return Infinity
    // Inside a box it does not hold (a new road just created the box
    // around it): stay put until it gets the box. Otherwise: stop line.
    return this.internalEdges.has(step.edge) ? v.progress : Math.max(0, length - this.stopDistanceAt(step.edge, step.to))
  }

  /** Room to enter the next lane: capacity and following distance. */
  private hasRoomAhead(v: MutableVehicle): boolean {
    const next = v.steps[v.stepIndex + 1]!
    const edge = this.graph.getEdge(next.edge)
    if (!edge || this.closedTo(v, edge)) return false
    const lane = this.lanes.get(laneKey(next))
    if (lane && lane.length >= edge.capacity) return false
    return this.gapAhead(v, v.stepIndex + 1, mixedVehicleMinGap(this.geometry)) >= -1e-9
  }

  private updateJunctions(dt: number): void {
    // Release: the holder is `stopDistance` past the box's last node (or gone).
    for (const [key, id] of [...this.junctionHolder]) {
      const v = this.fleet.get(id)
      const step = v?.steps[v.stepIndex]
      const inBox =
        !!step &&
        (this.internalEdges.has(step.edge) ||
          this.junctionKeys.get(step.to) === key ||
          (this.junctionKeys.get(step.from) === key && v!.progress < this.stopDistanceAt(step.edge, step.from) - 1e-9))
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
      // A vehicle still approaching may claim a free box once it is within
      // braking distance (plus one step) of the stop line, so it rolls
      // through instead of stopping at every junction (#31).
      const decel = VEHICLE_PROFILES[v.kind].decel
      const approach = (v.speed * v.speed) / (2 * decel) + v.speed * dt
      if (this.internalEdges.has(step.edge) || v.progress >= edge.length - this.stopDistanceAt(step.edge, step.to) - approach - 1e-6) candidates.push(v)
    }
    // Right-of-way (#32): remember when each vehicle started waiting for its box.
    for (const v of candidates) {
      const key = this.junctionKeys.get(v.steps[v.stepIndex]!.to)!
      const arrival = this.arrivals.get(v.id)
      if (!arrival || arrival.key !== key) this.arrivals.set(v.id, { key, at: this.time })
    }
    // Vehicles caught inside a box (on an internal edge, or past a stop line
    // that a new road just moved back) go first so they can clear it; then
    // oldest first.
    const inside = (v: MutableVehicle) => {
      const step = v.steps[v.stepIndex]!
      if (this.internalEdges.has(step.edge)) return 0
      const edge = this.graph.getEdge(step.edge)!
      return v.progress > edge.length - this.stopDistanceAt(step.edge, step.to) + 1e-6 ? 0 : 1
    }
    // Vehicles caught inside go first; the rest follow uncontrolled
    // right-of-way: first come, first served, then yield to the right.
    const caught = candidates.filter((v) => inside(v) === 0).sort((a, b) => a.id - b.id)
    const waiting = orderByRightOfWay(
      candidates
        .filter((v) => inside(v) !== 0)
        .map((v) => ({ v, id: v.id, arrivedAt: this.arrivals.get(v.id)!.at, heading: this.headingOf(v.steps[v.stepIndex]!) })),
    ).map((c) => c.v)
    // A box with vehicles stranded in it (a new road put the box around
    // them) is occupied: until they have cleared it, only they may claim it,
    // so nobody drives through them. Vehicles on a road inside the box come
    // first, then those merely past a stop line the new road moved back
    // (they have not entered the junction itself), then everyone else.
    const tier = (other: MutableVehicle) => this.strandTier(other)
    const strandedTier = new Map<NodeId, number>()
    for (const other of this.fleet.values()) {
      if (other.holding !== undefined) continue
      const key = this.junctionKeys.get(other.steps[other.stepIndex]!.to)
      if (key === undefined) continue
      const t = tier(other)
      if (t < 2) strandedTier.set(key, Math.min(t, strandedTier.get(key) ?? 2))
    }
    for (const v of [...caught, ...waiting]) {
      const step = v.steps[v.stepIndex]!
      const key = this.junctionKeys.get(step.to)!
      if (this.junctionHolder.has(key)) continue
      if (tier(v) > (strandedTier.get(key) ?? 2)) continue
      // Claim the box for the route actually driven through it.
      if (v.stepIndex + 1 < v.steps.length) this.replanIfStale(v)
      // Stranded vehicles may sit where another's path through the box runs
      // (e.g. in the wedge of a sharp join): only claim the box if this
      // vehicle's sweep through it clears every other stranded vehicle.
      if (strandedTier.has(key) && this.sweepHitsStranded(v, key, tier)) continue
      if (this.time < (this.junctionFreeAt.get(key) ?? 0) - 1e-9) continue
      // Signals (#32): only a green approach may enter (vehicles already
      // inside the box are never held by a light).
      if (inside(v) !== 0 && this.lightAt(v.steps[v.stepIndex]!) !== undefined && this.lightAt(v.steps[v.stepIndex]!) !== 'green') continue
      const exiting = v.stepIndex + 1 >= v.steps.length
      if (exiting) {
        // Leaving the map through this tunnel: nothing to make room for.
        this.junctionHolder.set(key, v.id)
        v.holding = key
        this.arrivals.delete(v.id)
        {
        const clearSec = this.clearSecFor(key)
        if (clearSec > 0) this.junctionFreeAt.set(key, this.time + clearSec)
      }
        continue
      }
      if (!this.remainingValid(v)) continue
      // Don't block the box: only enter with room to leave it.
      const next = v.steps[v.stepIndex + 1]!
      const nextEdge = this.graph.getEdge(next.edge)
      const nextLane = this.lanes.get(laneKey(next))
      if (!nextEdge || this.closedTo(v, nextEdge) || (nextLane && nextLane.length >= nextEdge.capacity)) continue
      const clear = this.stopDistanceAt(next.edge, next.from)
      if (this.gapAhead(v, v.stepIndex + 1, mixedVehicleMinGap(this.geometry)) < clear - 1e-9) continue
      this.junctionHolder.set(key, v.id)
      v.holding = key
      this.arrivals.delete(v.id)
      {
        const clearSec = this.clearSecFor(key)
        if (clearSec > 0) this.junctionFreeAt.set(key, this.time + clearSec)
      }
    }
  }

  private hasRoomAtEntry(step: RouteStep, kind: VehicleClass): boolean {
    const edge = this.graph.getEdge(step.edge)
    if (!edge || edge.blocked) return false
    const lane = this.lanes.get(laneKey(step))
    if (!lane || lane.length === 0) return true
    const rear = lane[lane.length - 1]!
    const candidate: MutableVehicle = { ...rear, kind }
    return lane.length < edge.capacity && rear.progress >= this.followingGap(candidate, rear) - 1e-9
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
      const kind = this.chooseVehicleClass()
      if (this.hasRoomAtEntry(result.route.steps[0]!, kind) && this.portalClear(origin)) {
        this.spawnVehicle(origin, destination, result.route.steps, kind)
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

  private chooseVehicleClass(): VehicleClass {
    const roll = this.random.next()
    if (roll < this.vehicleMix.car) return 'car'
    if (roll < this.vehicleMix.car + this.vehicleMix.van) return 'van'
    return 'truck'
  }

  private spawnVehicle(origin: NodeId, destination: NodeId, route: readonly RouteStep[], kind: VehicleClass): void {
    const v: MutableVehicle = {
      id: this.nextId++,
      kind,
      origin,
      destination,
      steps: [...route],
      stepIndex: 0,
      progress: 0,
      // Vehicles emerge from the tunnel already at cruising speed (#31).
      speed: (this.graph.getEdge(route[0]!.edge)?.speedLimit ?? 0) * VEHICLE_PROFILES[kind].speedFactor,
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
      {
        const clearSec = this.clearSecFor(key)
        if (clearSec > 0) this.junctionFreeAt.set(key, this.time + clearSec)
      }
    }
    this.totalSpawned++
  }

  private removeVehicle(v: MutableVehicle, step: RouteStep): void {
    const lane = this.lanes.get(laneKey(step))!
    lane.splice(lane.indexOf(v), 1)
    if (lane.length === 0) this.lanes.delete(laneKey(step))
    this.fleet.delete(v.id)
    this.arrivals.delete(v.id)
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


function normalizeVehicleMix(mix: Partial<VehicleMix> = {}): VehicleMix {
  const values: VehicleMix = {
    car: mix.car ?? DEFAULT_VEHICLE_MIX.car,
    van: mix.van ?? DEFAULT_VEHICLE_MIX.van,
    truck: mix.truck ?? DEFAULT_VEHICLE_MIX.truck,
  }
  for (const [kind, weight] of Object.entries(values)) {
    if (!Number.isFinite(weight) || weight < 0) throw new RangeError(`vehicle mix ${kind} must be a non-negative number`)
  }
  const total = values.car + values.van + values.truck
  if (!(total > 0)) throw new RangeError('vehicle mix must contain a positive weight')
  return Object.freeze({ car: values.car / total, van: values.van / total, truck: values.truck / total })
}

type Corner = readonly [number, number]

/** Separating-axis test for two convex quadrilaterals. */
function rectanglesOverlap(A: readonly Corner[], B: readonly Corner[]): boolean {
  for (const P of [A, B]) {
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = P[i]!
      const [x2, y2] = P[(i + 1) % 4]!
      const nx = y2 - y1
      const ny = x1 - x2
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity
      for (const [x, y] of A) {
        const d = x * nx + y * ny
        minA = Math.min(minA, d)
        maxA = Math.max(maxA, d)
      }
      for (const [x, y] of B) {
        const d = x * nx + y * ny
        minB = Math.min(minB, d)
        maxB = Math.max(maxB, d)
      }
      if (maxA <= minB || maxB <= minA) return false
    }
  }
  return true
}
