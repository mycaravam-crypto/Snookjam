import type { ConnectResult, Point, RoadGraph, RoadLocation } from '../roads/graph'
import type { World } from '../world/types'
import {
  checkConnection,
  DEFAULT_CONSTRUCTION_OPTIONS,
  snapToRoad,
  type ConnectionCheck,
  type ConstructionOptions,
  type RejectionReason,
} from './validate'

/** A road the player has built, for rendering. */
export interface BuiltRoad {
  readonly id: number
  readonly from: Point
  readonly to: Point
}

/** Live construction preview while the player is dragging. */
export interface ConstructionPreview {
  /** Snapped start on the network. */
  readonly from: Point
  /** Snapped end if valid/on a road, otherwise the raw pointer position. */
  readonly to: Point
  readonly check: ConnectionCheck
}

/** Result of releasing the pointer. */
export type ConstructionOutcome =
  | { readonly kind: 'committed'; readonly road: BuiltRoad; readonly result: ConnectResult }
  | { readonly kind: 'rejected'; readonly reason: RejectionReason; readonly from: Point; readonly to: Point }
  | { readonly kind: 'none' }

/**
 * Commits a validated connection. Defaults to `graph.connect`; a game session
 * can supply its own (e.g. one that also migrates vehicles on split edges).
 */
export type CommitConnection = (from: RoadLocation, to: RoadLocation) => ConnectResult

/**
 * Drag-to-build state machine. Takes world coordinates only: converting
 * pointer events to world points is the UI's job, and validation lives in
 * validate.ts.
 *
 *   pointerDown on a road -> preview starts
 *   pointerMove            -> preview follows the pointer and re-validates
 *   pointerUp              -> commits exactly one connection, or none
 *
 * Commits mutate the shared RoadGraph so later route queries use the new
 * road. `ConnectResult.splits` is passed on so traffic can migrate vehicles
 * on edges that were split.
 */
export class ConstructionController {
  private previewState: ConstructionPreview | undefined
  private readonly built: BuiltRoad[] = []
  private readonly listeners = new Set<() => void>()

  constructor(
    readonly world: World,
    readonly graph: RoadGraph,
    readonly options: ConstructionOptions = DEFAULT_CONSTRUCTION_OPTIONS,
    private readonly commit: CommitConnection = (from, to) => graph.connect(from, to),
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
      return false
    }
    this.previewState = this.makePreview(start.position, point)
    this.emit()
    return true
  }

  pointerMove(point: Point): void {
    if (!this.previewState) return
    this.previewState = this.makePreview(this.previewState.from, point)
    this.emit()
  }

  pointerUp(point: Point): ConstructionOutcome {
    if (!this.previewState) return { kind: 'none' }
    const preview = this.makePreview(this.previewState.from, point)
    this.previewState = undefined
    const { check } = preview
    let outcome: ConstructionOutcome
    if (check.ok) {
      const result = this.commit(check.from.location, check.to.location)
      const road: BuiltRoad = { id: this.built.length, from: check.from.position, to: check.to.position }
      this.built.push(road)
      outcome = { kind: 'committed', road, result }
    } else {
      outcome = { kind: 'rejected', reason: check.reason, from: preview.from, to: preview.to }
    }
    this.emit()
    return outcome
  }

  /** Abandons the current gesture without changing the graph. */
  cancel(): void {
    if (!this.previewState) return
    this.previewState = undefined
    this.emit()
  }

  private makePreview(from: Point, pointer: Point): ConstructionPreview {
    const check = checkConnection(this.world, this.graph, from, pointer, this.options)
    const to = check.to?.position ?? pointer
    return { from: check.from?.position ?? from, to, check }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
