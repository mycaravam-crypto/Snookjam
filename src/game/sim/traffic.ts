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
 * - At the end of an edge a vehicle may only enter its next lane if that lane
 *   is below capacity and the last vehicle in it has cleared `minGap`.
 *   Otherwise it waits at the junction, which is how queues form.
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
  /** Minimum distance in tiles between consecutive vehicles in a lane. */
  readonly minGap?: number
  /** Upper bound on queued-but-not-yet-entered spawns. */
  readonly maxPendingSpawns?: number
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
  spawnedAt: number
  /** Graph version the remaining steps were planned against. */
  routeVersion: number
  /** Graph version of the last failed re-plan (for stuck vehicles). */
  failedVersion: number
}

const laneKey = (step: RouteStep): string => `${step.edge}>${step.from}`

export class TrafficSim {
  private readonly graph: RoadGraph
  private readonly portals: readonly NodeId[]
  private readonly random: RandomSource
  readonly maxVehicles: number
  readonly minSpawnIntervalSec: number
  readonly minGap: number
  readonly maxPendingSpawns: number

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

  constructor(graph: RoadGraph, options: TrafficOptions) {
    this.graph = graph
    this.portals = [...options.portals]
    for (const p of this.portals) if (!graph.hasNode(p)) throw new Error(`portal node ${p} is not in the graph`)
    this.random = options.random
    this.maxVehicles = options.maxVehicles ?? DEFAULT_CONFIG.maxVehicles
    this.spawnInterval = options.spawnIntervalSec ?? DEFAULT_CONFIG.initialSpawnIntervalSec
    this.minSpawnIntervalSec = options.minSpawnIntervalSec ?? DEFAULT_CONFIG.minSpawnIntervalSec
    this.minGap = options.minGap ?? VEHICLE_SPACING
    this.maxPendingSpawns = options.maxPendingSpawns ?? this.maxVehicles
    this.pending = Math.min(options.startingVehicles ?? DEFAULT_CONFIG.startingVehicles, this.maxPendingSpawns)
    if (!(this.minGap > 0)) throw new RangeError('minGap must be positive')
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

  /** Advances the simulation by one fixed step of `dt` seconds. */
  step(dt: number): StepReport {
    if (!(dt > 0)) throw new RangeError('dt must be positive')
    this.time += dt
    this.ticks++
    let exited = 0
    let unroutable = 0

    // 1. Movement within lanes, front to back.
    const atEnd: MutableVehicle[] = []
    for (const lane of this.lanes.values()) {
      let limit = Infinity
      for (const v of lane) {
        const step = v.steps[v.stepIndex]!
        const edge = this.graph.getEdge(step.edge)!
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

    for (const v of this.fleet.values()) if (v.state !== 'moving') v.waitTime += dt
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
    if (!this.hasRoomAtEntry(next)) {
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
      if (this.hasRoomAtEntry(result.route.steps[0]!)) {
        this.spawnVehicle(origin, destination, result.route.steps)
        return 'spawned'
      }
    }
    return 'blocked'
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
      spawnedAt: this.time,
      routeVersion: this.graph.version,
      failedVersion: -1,
    }
    this.fleet.set(v.id, v)
    this.laneFor(route[0]!).push(v)
    this.totalSpawned++
  }

  private removeVehicle(v: MutableVehicle, step: RouteStep): void {
    const lane = this.lanes.get(laneKey(step))!
    lane.splice(lane.indexOf(v), 1)
    if (lane.length === 0) this.lanes.delete(laneKey(step))
    this.fleet.delete(v.id)
  }

  private laneFor(step: RouteStep): MutableVehicle[] {
    const key = laneKey(step)
    let lane = this.lanes.get(key)
    if (!lane) this.lanes.set(key, (lane = []))
    return lane
  }
}
