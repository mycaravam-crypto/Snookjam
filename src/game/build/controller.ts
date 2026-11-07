import type { ConnectResult, NearestLocation, Point, RoadGraph, RoadLocation } from '../roads/graph'
import type { World } from '../world/types'
import { appendSample } from './path'
import {
  checkPath,
  DEFAULT_CONSTRUCTION_OPTIONS,
  snapToRoad,
  type ConstructionOptions,
  type PathCheck,
  type RejectionReason,
} from './validate'

/** A road the player has built, for rendering. */
export interface BuiltRoad {
  readonly id: number
  readonly from: Point
  readonly to: Point
  /** Full polyline from `from` to `to` (two points for a straight road). */
  readonly points: readonly Point[]
}

/** Live construction preview while the player is dragging. */
export interface ConstructionPreview {
  /** Snapped start on the network. */
  readonly from: Point
  /** Snapped end if on a road, otherwise the raw pointer position. */
  readonly to: Point
  /** Raw pointer position. */
  readonly pointer: Point
  /** Smoothed road geometry that would be built, from `from` to `to`. */
  readonly path: readonly Point[]
  /** Where the end currently snaps to, if within tolerance. */
  readonly endSnap?: NearestLocation
  readonly check: PathCheck
}

/** Result of releasing the pointer. */
export type ConstructionOutcome =
  | { readonly kind: 'committed'; readonly road: BuiltRoad; readonly result: ConnectResult }
  | {
      readonly kind: 'rejected'
      readonly reason: RejectionReason
      readonly from: Point
      readonly to: Point
      readonly path: readonly Point[]
    }
  | { readonly kind: 'none' }

/**
 * Commits a validated connection. `via` holds the bends of a freehand road
 * (empty for a straight one). Defaults to `graph.connect`; a game session can
 * supply its own (e.g. one that also migrates vehicles on split edges). It
 * must leave the graph unchanged if it throws.
 */
export type ConstructionTarget = RoadLocation | { readonly kind: 'point'; readonly position: Point }
export type CommitConnection = (from: RoadLocation, to: ConstructionTarget, via: readonly Point[]) => ConnectResult

/**
 * Freehand drag-to-build state machine (#6, #18). Takes world coordinates
 * only: converting pointer events to world points is the UI's job, path
 * geometry lives in path.ts and validation in validate.ts.
 *
 *   pointerDown on a road -> preview starts, trajectory capture begins
 *   pointerMove            -> samples are recorded; the smoothed preview
 *                             follows them and the end re-snaps continuously,
 *                             staying latched to its road (endSnapRelease)
 *   pointerUp              -> commits exactly one road, or none
 *
 * Commits mutate the shared RoadGraph so later route queries use the new
 * road. `ConnectResult.splits` is passed on so traffic can migrate vehicles
 * on edges that were split.
 */
export class ConstructionController {
  private previewState: ConstructionPreview | undefined
  private samples: Point[] = []
  private readonly built: BuiltRoad[] = []
  private readonly listeners = new Set<() => void>()

  constructor(
    readonly world: World,
    readonly graph: RoadGraph,
    readonly options: ConstructionOptions = DEFAULT_CONSTRUCTION_OPTIONS,
    private readonly commit: CommitConnection = (from, to, via) =>
      to.kind === 'point' ? graph.connectToPoint(from, to.position, {}, via) : graph.connect(from, to, {}, via),
  ) {}

  get preview(): ConstructionPreview | undefined {
    return this.previewState
  }

  get builtRoads(): readonly BuiltRoad[] {
    return this.built
  }

  get isDrawing(): boolean {
    return this.previewState !== undefined
  }

  /** Subscribe to state changes; returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Starts a preview if `point` is on a road. Returns whether it started. */
  pointerDown(point: Point): boolean {
    const start = snapToRoad(this.graph, point, this.options)
    if (!start) {
      this.previewState = undefined
      this.samples = []
      return false
    }
    this.samples = [{ x: point.x, y: point.y }]
    this.previewState = undefined // a new gesture starts without a latch
    this.previewState = this.makePreview(start.position, point)
    this.emit()
    return true
  }

  /**
   * Records pointer positions (pass several for coalesced pointer events) and
   * updates the preview once.
   */
  pointerMove(points: Point | readonly Point[]): void {
    if (!this.previewState) return
    const list: readonly Point[] = Array.isArray(points) ? points : [points as Point]
    if (list.length === 0) return
    for (const p of list) appendSample(this.samples, p, this.options.sampleSpacing)
    this.previewState = this.makePreview(this.previewState.from, list[list.length - 1]!)
    this.emit()
  }

  pointerUp(point: Point): ConstructionOutcome {
    if (!this.previewState) return { kind: 'none' }
    appendSample(this.samples, point, this.options.sampleSpacing)
    const preview = this.makePreview(this.previewState.from, point)
    this.previewState = undefined
    this.samples = []
    const { check } = preview
    let outcome: ConstructionOutcome
    const rejected = (reason: RejectionReason): ConstructionOutcome => ({
      kind: 'rejected',
      reason,
      from: preview.from,
      to: preview.to,
      path: preview.path,
    })
    if (check.ok) {
      try {
        const target: ConstructionTarget = check.to?.location ?? { kind: 'point', position: preview.pointer }
        const result = this.commit(check.from.location, target, check.path.slice(1, -1))
        const road: BuiltRoad = {
          id: this.built.length,
          from: check.from.position,
          to: check.to?.position ?? preview.pointer,
          points: check.path,
        }
        this.built.push(road)
        outcome = { kind: 'committed', road, result }
      } catch {
        // The commit function rejected it (e.g. game over); graph unchanged.
        outcome = rejected('build-failed')
      }
    } else {
      outcome = rejected(check.reason)
    }
    this.emit()
    return outcome
  }

  /** Abandons the current gesture without changing the graph. */
  cancel(): void {
    if (!this.previewState) return
    this.previewState = undefined
    this.samples = []
    this.emit()
  }

  private makePreview(from: Point, pointer: Point): ConstructionPreview {
    // Latch to the road the end snapped to on the previous preview, unless
    // that is the road the gesture started on (the end starts out there).
    const previous = this.previewState
    const latch =
      previous?.endSnap && !this.sharesRoad(previous.endSnap.location, previous.check.from?.location)
        ? previous.endSnap.location
        : undefined
    const check = checkPath(this.world, this.graph, from, pointer, this.samples.slice(1), this.options, latch)
    const to = check.to?.position ?? pointer
    return {
      from: check.from?.position ?? from,
      to,
      pointer: { x: pointer.x, y: pointer.y },
      path: check.path.length > 0 ? check.path : [from, pointer],
      ...(check.to ? { endSnap: check.to } : {}),
      check,
    }
  }

  private sharesRoad(a: RoadLocation, b: RoadLocation | undefined): boolean {
    if (!b) return false
    const edges = (l: RoadLocation) => (l.kind === 'edge' ? [l.edge] : this.graph.edgesAt(l.node).map((e) => e.id))
    const other = edges(b)
    return edges(a).some((e) => other.includes(e))
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
