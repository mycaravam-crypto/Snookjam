/**
 * Traffic diagnostics (#34): network statistics, a per-road congestion
 * heat value, persistent bottlenecks and blocked junctions.
 *
 * The monitor only *reads* the traffic sim after each fixed step, so it can
 * never change simulation behaviour. Work per step is O(vehicles + roads
 * with heat), with no per-frame recomputation in the renderer or HUD.
 *
 * Metric definitions (all times are simulation seconds):
 *
 * - **Completed journeys:** vehicles that reached their destination tunnel
 *   since the level started.
 * - **Active vehicles:** vehicles currently on the map.
 * - **Average travel time:** mean of (exit time − spawn time) over completed
 *   journeys. `undefined` until the first journey completes.
 * - **Average waiting time:** mean seconds a completed journey spent not
 *   moving (queued at a stop line, behind another vehicle, or stuck).
 *   `undefined` until the first journey completes.
 * - **Waiting now:** active vehicles that did not move in the last step.
 * - **Throughput:** completed journeys per minute over the last
 *   `throughputWindowSec` (60 s), or over the elapsed time when less has
 *   passed. `undefined` for the first `minThroughputSec` (15 s), when a
 *   single exit would read as a misleadingly high rate.
 * - **Road heat (queue occupancy):** for each lane, the share of its length
 *   filled by stopped vehicles, counting each at the minimum following
 *   distance (`minGap`). A road's instantaneous value is its fuller lane,
 *   capped at 1, and the heat is that value smoothed exponentially with a
 *   `heatTimeConstantSec` (4 s) time constant, so short stops at a stop line
 *   barely register while a standing queue climbs towards 1.
 * - **Persistent bottleneck:** a road whose heat has stayed at or above
 *   `bottleneckHeat` (0.5) for at least `bottleneckAfterSec` (8 s).
 * - **Blocked junction:** a node where the front vehicle of an incoming lane
 *   has not moved for at least `blockedAfterSec` (2 s, the same threshold the
 *   congestion meter uses for blocked vehicles).
 */
import type { EdgeId, EdgeSplit, NodeId, RemovalResult, RoadGraph } from '../roads'
import type { TrafficSim, Vehicle } from '../sim'

export interface DiagnosticsOptions {
  /** Seconds a stationary lane-front vehicle must wait for its junction to count as blocked. */
  readonly blockedAfterSec?: number
  /** Time constant of the road heat smoothing. */
  readonly heatTimeConstantSec?: number
  /** Heat at or above which a road is treated as queued. */
  readonly bottleneckHeat?: number
  /** Seconds a road must stay queued to be a persistent bottleneck. */
  readonly bottleneckAfterSec?: number
  readonly throughputWindowSec?: number
  readonly minThroughputSec?: number
  /** Road length taken up by one queued vehicle; defaults to the sim's minGap. */
  readonly queueSpacing?: number
}

export const DEFAULT_DIAGNOSTICS: Required<Omit<DiagnosticsOptions, 'queueSpacing'>> = Object.freeze({
  blockedAfterSec: 2,
  heatTimeConstantSec: 4,
  bottleneckHeat: 0.5,
  bottleneckAfterSec: 8,
  throughputWindowSec: 60,
  minThroughputSec: 15,
})

/** Summary numbers for the HUD. */
export interface NetworkStats {
  readonly elapsedSec: number
  readonly completedJourneys: number
  readonly activeVehicles: number
  readonly waitingVehicles: number
  readonly averageTravelSec: number | undefined
  readonly averageWaitSec: number | undefined
  readonly throughputPerMin: number | undefined
  readonly bottlenecks: number
  readonly blockedJunctions: number
}

export interface RoadHeat {
  readonly edge: EdgeId
  /** 0–1 smoothed queue occupancy. */
  readonly heat: number
  /** Seconds the road has continuously been at or above the bottleneck heat. */
  readonly queuedForSec: number
  readonly persistent: boolean
}

interface MutableHeat {
  heat: number
  queuedFor: number
}

interface Tracked {
  spawnedAt: number
  waitTime: number
}

export const EMPTY_NETWORK_STATS: NetworkStats = Object.freeze({
  elapsedSec: 0,
  completedJourneys: 0,
  activeVehicles: 0,
  waitingVehicles: 0,
  averageTravelSec: undefined,
  averageWaitSec: undefined,
  throughputPerMin: undefined,
  bottlenecks: 0,
  blockedJunctions: 0,
})

export class NetworkMonitor {
  readonly options: Required<DiagnosticsOptions>
  private readonly heatByEdge = new Map<EdgeId, MutableHeat>()
  private readonly tracked = new Map<number, Tracked>()
  /** Exit times inside the throughput window, oldest first. */
  private readonly exitTimes: number[] = []
  private blocked: NodeId[] = []
  private elapsed = 0
  private completed = 0
  private totalTravel = 0
  private totalWait = 0
  private waitingNow = 0
  private activeNow = 0
  private cached: NetworkStats | undefined

  constructor(
    readonly graph: RoadGraph,
    readonly sim: TrafficSim,
    options: DiagnosticsOptions = {},
  ) {
    this.options = { ...DEFAULT_DIAGNOSTICS, queueSpacing: sim.minGap, ...options }
    for (const v of sim.vehicles()) this.tracked.set(v.id, { spawnedAt: v.spawnedAt, waitTime: v.waitTime })
  }

  /** Call once after each `sim.step(dt)`. */
  observe(dt: number): void {
    if (!(dt > 0)) throw new RangeError('dt must be positive')
    const now = this.sim.stats().time
    this.elapsed += dt
    this.cached = undefined
    const vehicles = this.sim.vehicles()

    // Journeys: vehicles that left the fleet since the last step have exited
    // (the sim only removes vehicles at their destination tunnel).
    const seen = new Set<number>()
    for (const v of vehicles) seen.add(v.id)
    for (const [id, t] of this.tracked) {
      if (seen.has(id)) continue
      this.tracked.delete(id)
      this.completed++
      this.totalTravel += now - t.spawnedAt
      this.totalWait += t.waitTime
      this.exitTimes.push(now)
    }
    const windowStart = now - this.options.throughputWindowSec
    while (this.exitTimes.length > 0 && this.exitTimes[0]! <= windowStart + 1e-9) this.exitTimes.shift()

    // Lane queues and blocked junctions.
    let waiting = 0
    const queuedByLane = new Map<string, number>()
    const blocked = new Set<NodeId>()
    for (const v of vehicles) {
      this.tracked.set(v.id, { spawnedAt: v.spawnedAt, waitTime: v.waitTime })
      if (v.state === 'moving') continue
      waiting++
      const step = v.steps[v.stepIndex]
      if (!step) continue
      const key = `${step.edge}>${step.from}`
      queuedByLane.set(key, (queuedByLane.get(key) ?? 0) + 1)
      if (v.waitingFor >= this.options.blockedAfterSec - 1e-9 && this.isLaneFront(v)) blocked.add(step.to)
    }
    this.waitingNow = waiting
    this.activeNow = vehicles.length
    this.blocked = [...blocked].sort((a, b) => a - b)

    // Instantaneous occupancy per road: the fuller of its two lanes.
    const occupancy = new Map<EdgeId, number>()
    for (const [key, count] of queuedByLane) {
      const edgeId = Number(key.slice(0, key.indexOf('>')))
      const edge = this.graph.getEdge(edgeId)
      if (!edge || edge.length <= 0) continue
      const fill = Math.min(1, (count * this.options.queueSpacing) / edge.length)
      occupancy.set(edgeId, Math.max(occupancy.get(edgeId) ?? 0, fill))
    }

    const alpha = 1 - Math.exp(-dt / this.options.heatTimeConstantSec)
    for (const edgeId of occupancy.keys()) {
      if (!this.heatByEdge.has(edgeId)) this.heatByEdge.set(edgeId, { heat: 0, queuedFor: 0 })
    }
    for (const [edgeId, h] of this.heatByEdge) {
      if (!this.graph.getEdge(edgeId)) {
        this.heatByEdge.delete(edgeId)
        continue
      }
      h.heat += ((occupancy.get(edgeId) ?? 0) - h.heat) * alpha
      h.queuedFor = h.heat >= this.options.bottleneckHeat ? h.queuedFor + dt : 0
      if (h.heat < 1e-3 && !occupancy.has(edgeId)) this.heatByEdge.delete(edgeId)
    }
  }

  /** Keeps a road's heat on both halves when construction splits it. */
  applySplit(split: EdgeSplit): void {
    const h = this.heatByEdge.get(split.removed)
    if (!h) return
    this.heatByEdge.delete(split.removed)
    this.heatByEdge.set(split.towardA, { ...h })
    this.heatByEdge.set(split.towardB, { ...h })
    this.cached = undefined
  }

  /**
   * Keeps heat consistent when a player road is removed (#33): roads merged
   * back together keep the hotter half's heat; removed roads drop theirs.
   */
  applyRemoval(result: RemovalResult): void {
    for (const merge of result.merges) {
      const halves = [this.heatByEdge.get(merge.fromA), this.heatByEdge.get(merge.fromB)].filter((h) => h !== undefined)
      this.heatByEdge.delete(merge.fromA)
      this.heatByEdge.delete(merge.fromB)
      if (halves.length > 0) {
        const hottest = halves.reduce((x, y) => (y.heat > x.heat ? y : x))
        this.heatByEdge.set(merge.merged, { ...hottest })
      }
    }
    for (const id of result.removedEdges) this.heatByEdge.delete(id)
    this.cached = undefined
  }

  /** Heat of one road (0 when it has no queue). */
  heatOf(edge: EdgeId): number {
    return this.heatByEdge.get(edge)?.heat ?? 0
  }

  /** Roads with any heat, hottest first (ties by edge id). */
  roads(): RoadHeat[] {
    const out: RoadHeat[] = []
    for (const [edge, h] of this.heatByEdge) {
      out.push({ edge, heat: h.heat, queuedForSec: h.queuedFor, persistent: this.isPersistent(h) })
    }
    return out.sort((a, b) => b.heat - a.heat || a.edge - b.edge)
  }

  /** Nodes whose incoming queue has been stationary past the blocked threshold. */
  blockedJunctions(): readonly NodeId[] {
    return this.blocked
  }

  stats(): NetworkStats {
    if (this.cached) return this.cached
    let bottlenecks = 0
    for (const h of this.heatByEdge.values()) if (this.isPersistent(h)) bottlenecks++
    const span = Math.min(this.options.throughputWindowSec, this.elapsed)
    this.cached = {
      elapsedSec: this.elapsed,
      completedJourneys: this.completed,
      activeVehicles: this.activeNow,
      waitingVehicles: this.waitingNow,
      averageTravelSec: this.completed > 0 ? this.totalTravel / this.completed : undefined,
      averageWaitSec: this.completed > 0 ? this.totalWait / this.completed : undefined,
      throughputPerMin: this.elapsed + 1e-9 >= this.options.minThroughputSec ? (this.exitTimes.length / span) * 60 : undefined,
      bottlenecks,
      blockedJunctions: this.blocked.length,
    }
    return this.cached
  }

  private isPersistent(h: MutableHeat): boolean {
    return h.queuedFor + 1e-9 >= this.options.bottleneckAfterSec
  }

  private isLaneFront(v: Vehicle): boolean {
    const step = v.steps[v.stepIndex]!
    return this.sim.laneOccupants(step.edge, step.from)[0]?.id === v.id
  }
}
