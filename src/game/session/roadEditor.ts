/**
 * Player road editing (#33): a record of every road the player built, safe
 * removal, and a bounded undo/redo history.
 *
 * Roads are recorded by their drawn geometry (the committed centre line), and
 * every graph edge of a road carries its id (`RoadEdge.road`, kept through
 * later splits). That makes edits independent of graph ids, which change
 * whenever edges are split or merged:
 *
 * - Removing a road removes its edges, and merges back any edge it had split,
 *   so the network returns to how it was before the road (RoadGraph.removeEdges).
 * - A road with vehicles on it cannot vanish under them. It *closes* instead:
 *   its edges are blocked, so no new routes use it, vehicles already on it
 *   drive off, and it is removed once it is empty. Nobody teleports.
 * - Rebuilding a road (redo a build, undo a removal) replays its geometry
 *   through RoadGraph.connect, which recreates the same junctions.
 *
 * Every operation either completes or leaves the graph and simulation
 * unchanged. Generated roads are never edited.
 */
import { pointSegmentDistance } from '../build/path'
import type { ConnectResult, EdgeOptions, Point, RemovalResult, RoadGraph, RoadLocation } from '../roads'
import type { TrafficSim } from '../sim'

/**
 * Applies graph changes to everything that references graph edges (the
 * traffic sim, diagnostics). Defaults to the sim alone.
 */
export interface TopologyListener {
  connected(result: ConnectResult): void
  removed(result: RemovalResult): void
}

export type PlayerRoadState = 'open' | 'closing' | 'removed'

export interface PlayerRoad {
  readonly id: number
  /** Committed centre line, from the start to the end. */
  readonly points: readonly Point[]
  /** Whether the end joins another road (otherwise it is a dead end). */
  readonly endsOnRoad: boolean
  readonly state: PlayerRoadState
}

export type EditAction = 'built' | 'removed' | 'closing' | 'reopened'

export type EditResult =
  | { readonly ok: true; readonly action: EditAction; readonly road: number }
  | { readonly ok: false; readonly reason: 'nothing-to-undo' | 'nothing-to-redo' | 'not-found' | 'failed' }

/** A vehicle this far (tiles) past a road's end has finished turning off it. */
const TURN_CLEARANCE = 1

/** Undo steps kept; older ones are dropped. */
export const MAX_EDIT_HISTORY = 50

interface HistoryEntry {
  readonly kind: 'build' | 'remove'
  readonly road: number
}

interface MutableRoad {
  id: number
  points: readonly Point[]
  endsOnRoad: boolean
  state: PlayerRoadState
}

export class RoadEditor {
  private readonly records = new Map<number, MutableRoad>()
  private readonly undoStack: HistoryEntry[] = []
  private readonly redoStack: HistoryEntry[] = []
  private nextId = 1
  private versionCounter = 0

  private readonly topology: TopologyListener

  constructor(
    private readonly graph: RoadGraph,
    private readonly sim: TrafficSim,
    topology?: TopologyListener,
  ) {
    this.topology = topology ?? {
      connected: (result) => {
        for (const split of result.splits) sim.applySplit(split)
      },
      removed: (result) => sim.applyRemoval(result),
    }
  }

  /** Changes whenever the set of drawn roads (or their state) changes. */
  get version(): number {
    return this.versionCounter
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** Roads currently on the map (open or closing), oldest first. */
  roads(): readonly PlayerRoad[] {
    return [...this.records.values()].filter((r) => r.state !== 'removed').map((r) => ({ ...r }))
  }

  road(id: number): PlayerRoad | undefined {
    const r = this.records.get(id)
    return r && { ...r }
  }

  /** The player road nearest to `point` within `maxDistance` tiles. */
  roadAt(point: Point, maxDistance: number): PlayerRoad | undefined {
    let best: { road: MutableRoad; d: number } | undefined
    for (const road of this.records.values()) {
      if (road.state === 'removed') continue
      for (let i = 1; i < road.points.length; i++) {
        const d = pointSegmentDistance(point, road.points[i - 1]!, road.points[i]!)
        if (d <= maxDistance && (!best || d < best.d - 1e-9)) best = { road, d }
      }
    }
    return best && { ...best.road }
  }

  /**
   * Whether any vehicle is on the road, or has only just turned off it (its
   * turn is still drawn along the road's last stretch).
   */
  isOccupied(id: number): boolean {
    const edges = new Set(this.graph.roadEdges(id).map((e) => e.id))
    return this.sim.vehicles().some((v) => {
      if (edges.has(v.steps[v.stepIndex]!.edge)) return true
      const prev = v.steps[v.stepIndex - 1]
      return prev !== undefined && edges.has(prev.edge) && v.progress < TURN_CLEARANCE
    })
  }

  /** Builds a new player road and records it (clears the redo history). */
  build(from: RoadLocation, to: RoadLocation | Point, via: readonly Point[], options: EdgeOptions = {}): ConnectResult {
    const id = this.nextId
    const toPoint = !('kind' in to)
    const points = [this.graph.positionOf(from), ...via, toPoint ? to : this.graph.positionOf(to)]
    const tagged = { ...options, road: id }
    const result = toPoint ? this.graph.connectToPoint(from, to, tagged, via) : this.graph.connect(from, to, tagged, via)
    this.topology.connected(result)
    this.nextId++
    this.records.set(id, { id, points: points.map((p) => ({ x: p.x, y: p.y })), endsOnRoad: !toPoint, state: 'open' })
    this.versionCounter++
    this.push({ kind: 'build', road: id })
    return result
  }

  /** Removes a player road (closing it first if vehicles are on it). */
  remove(id: number): EditResult {
    const road = this.records.get(id)
    if (!road || road.state !== 'open') return { ok: false, reason: 'not-found' }
    const action = this.takeDown(road)
    this.push({ kind: 'remove', road: id })
    return { ok: true, action, road: id }
  }

  undo(): EditResult {
    const entry = this.undoStack.pop()
    if (!entry) return { ok: false, reason: 'nothing-to-undo' }
    const result = this.apply(entry, entry.kind === 'build' ? 'down' : 'up')
    if (result.ok) this.redoStack.push(entry)
    else this.undoStack.push(entry)
    return result
  }

  redo(): EditResult {
    const entry = this.redoStack.pop()
    if (!entry) return { ok: false, reason: 'nothing-to-redo' }
    const result = this.apply(entry, entry.kind === 'build' ? 'up' : 'down')
    if (result.ok) this.undoStack.push(entry)
    else this.redoStack.push(entry)
    return result
  }

  /** Removes closing roads that have become empty. Call once per simulation step. */
  update(): void {
    for (const road of this.records.values()) {
      if (road.state === 'closing' && !this.isOccupied(road.id)) this.removeNow(road)
    }
  }

  /** 'up' puts the road on the map, 'down' takes it off. */
  private apply(entry: HistoryEntry, direction: 'up' | 'down'): EditResult {
    const road = this.records.get(entry.road)
    if (!road) return { ok: false, reason: 'not-found' }
    if (direction === 'down') {
      if (road.state !== 'open') return { ok: false, reason: 'failed' }
      return { ok: true, action: this.takeDown(road), road: road.id }
    }
    if (road.state === 'open') return { ok: false, reason: 'failed' }
    if (road.state === 'closing') {
      for (const edge of this.graph.roadEdges(road.id)) this.graph.setBlocked(edge.id, false)
      road.state = 'open'
      this.versionCounter++
      return { ok: true, action: 'reopened', road: road.id }
    }
    return this.rebuild(road) ? { ok: true, action: 'built', road: road.id } : { ok: false, reason: 'failed' }
  }

  private takeDown(road: MutableRoad): 'removed' | 'closing' {
    if (!this.isOccupied(road.id)) {
      this.removeNow(road)
      return 'removed'
    }
    for (const edge of this.graph.roadEdges(road.id)) this.graph.setBlocked(edge.id, true)
    road.state = 'closing'
    this.versionCounter++
    return 'closing'
  }

  private removeNow(road: MutableRoad): void {
    const result = this.graph.removeEdges(this.graph.roadEdges(road.id).map((e) => e.id))
    this.topology.removed(result)
    road.state = 'removed'
    this.versionCounter++
  }

  /** Replays a removed road's geometry. Returns false (and changes nothing) if it no longer fits. */
  private rebuild(road: MutableRoad): boolean {
    const first = road.points[0]!
    const last = road.points[road.points.length - 1]!
    const from = this.graph.nearestLocation(first, 1e-4, 1e-4)
    // A dead end may since have become another road's start: join it then.
    const to = this.graph.nearestLocation(last, 1e-4, 1e-4)
    if (!from || (road.endsOnRoad && !to)) return false
    const via = road.points.slice(1, -1)
    let result: ConnectResult
    try {
      result = to
        ? this.graph.connect(from.location, to.location, { road: road.id }, via)
        : this.graph.connectToPoint(from.location, last, { road: road.id }, via)
    } catch {
      return false
    }
    this.topology.connected(result)
    road.state = 'open'
    this.versionCounter++
    return true
  }

  private push(entry: HistoryEntry): void {
    this.undoStack.push(entry)
    if (this.undoStack.length > MAX_EDIT_HISTORY) this.undoStack.shift()
    this.redoStack.length = 0
  }
}
