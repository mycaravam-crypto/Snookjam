/**
 * Junction movements, right-of-way and traffic signals (#32).
 *
 * A junction is one junction box of the traffic simulation: a single
 * intersection node, or several intersections close enough to share a box.
 * Its *approaches* are the lanes that enter the box from outside, its *exits*
 * the lanes that leave it, and its *movements* every approach → exit pair
 * except U-turns back down the same road. The box admits one vehicle at a
 * time, so conflicting movements can never occupy it together; right-of-way
 * and signals only decide *who* gets the box next.
 *
 * Everything here is pure and deterministic. Roundabouts or other junction
 * types can later supply their own admission rule over the same movements
 * without touching routing.
 */
import type { EdgeId, NodeId, Point, RoadGraph } from '../roads'

/** A lane entering (approach) or leaving (exit) a junction box. */
export interface JunctionLane {
  readonly edge: EdgeId
  /** The box node this lane meets. */
  readonly node: NodeId
  /** Direction of travel along the lane at the box (radians, screen/world y down). */
  readonly heading: number
}

export interface JunctionMovement {
  readonly approach: JunctionLane
  readonly exit: JunctionLane
}

export interface Junction {
  /** The box key: the lowest node id in the box. */
  readonly key: NodeId
  readonly nodes: readonly NodeId[]
  readonly center: Point
  readonly approaches: readonly JunctionLane[]
  readonly exits: readonly JunctionLane[]
  readonly movements: readonly JunctionMovement[]
  /** Tunnel boxes cannot take signals. */
  readonly portal: boolean
}

/**
 * Describes the junction box made of `nodes`. `internal` holds edges inside a
 * merged box (between its nodes), which are neither approaches nor exits.
 */
export function describeJunction(
  graph: RoadGraph,
  key: NodeId,
  nodes: readonly NodeId[],
  internal: ReadonlySet<EdgeId>,
  portal: boolean,
): Junction {
  const members = new Set(nodes)
  const approaches: JunctionLane[] = []
  const exits: JunctionLane[] = []
  let cx = 0
  let cy = 0
  for (const n of nodes) {
    const node = graph.getNode(n)!
    cx += node.position.x
    cy += node.position.y
    for (const edge of graph.edgesAt(n)) {
      if (internal.has(edge.id)) continue
      const other = graph.otherEnd(edge, n)
      // An edge between two box nodes that is not internal still belongs to the box.
      if (members.has(other) && other !== n) continue
      const q = graph.getNode(other)!.position
      const outward = Math.atan2(q.y - node.position.y, q.x - node.position.x)
      approaches.push({ edge: edge.id, node: n, heading: normalizeAngle(outward + Math.PI) })
      exits.push({ edge: edge.id, node: n, heading: outward })
    }
  }
  const byId = (a: JunctionLane, b: JunctionLane) => a.edge - b.edge || a.node - b.node
  approaches.sort(byId)
  exits.sort(byId)
  const movements: JunctionMovement[] = []
  for (const approach of approaches) {
    for (const exit of exits) if (exit.edge !== approach.edge) movements.push({ approach, exit })
  }
  return {
    key,
    nodes: [...nodes].sort((a, b) => a - b),
    center: { x: cx / nodes.length, y: cy / nodes.length },
    approaches,
    exits,
    movements,
    portal,
  }
}

/** Angle in (-π, π]. */
export function normalizeAngle(a: number): number {
  let r = a % (2 * Math.PI)
  if (r <= -Math.PI) r += 2 * Math.PI
  if (r > Math.PI) r -= 2 * Math.PI
  return r
}

/**
 * Whether a vehicle heading `other` comes from the right of one heading
 * `self`. Vehicles drive on the right, and y points down, so a vehicle from
 * the right travels roughly a quarter turn anticlockwise of `self`.
 */
export function comesFromRight(self: number, other: number): boolean {
  const diff = normalizeAngle(other - self)
  return diff < -Math.PI / 4 && diff > (-3 * Math.PI) / 4
}

/** A vehicle waiting for (or approaching) a junction box. */
export interface RightOfWayCandidate {
  readonly id: number
  /** Simulation time it reached the stop line (or came within braking distance). */
  readonly arrivedAt: number
  /** Heading of its approach lane. */
  readonly heading: number
}

/**
 * Uncontrolled right-of-way (#32): first come, first served by arrival at the
 * stop line. Vehicles that arrived in the same step yield to traffic from
 * their right: the one with the fewest tied vehicles on its right goes first,
 * then the lowest id (which also settles a four-way standoff). Returns a new,
 * ordered array; deterministic for the same input.
 */
export function orderByRightOfWay<T extends RightOfWayCandidate>(candidates: readonly T[], tolerance = 1e-6): T[] {
  const onRight = (c: T) =>
    candidates.filter((o) => o !== c && Math.abs(o.arrivedAt - c.arrivedAt) <= tolerance && comesFromRight(c.heading, o.heading)).length
  const rank = new Map(candidates.map((c) => [c, onRight(c)]))
  return [...candidates].sort((a, b) => {
    if (Math.abs(a.arrivedAt - b.arrivedAt) > tolerance) return a.arrivedAt - b.arrivedAt
    return rank.get(a)! - rank.get(b)! || a.id - b.id
  })
}

/** Green times the player can choose, in seconds. */
export const SIGNAL_GREEN_OPTIONS = [5, 10, 15] as const
export const DEFAULT_SIGNAL_GREEN_SEC = 10
/** All-red time after each green, so the box clears before the next phase. */
export const SIGNAL_CLEARANCE_SEC = 1.5

export interface SignalOptions {
  /** Green time per phase, in seconds. */
  readonly greenSec?: number
}

export type SignalLight = 'green' | 'amber' | 'red'

/**
 * Default phases: approaches heading in opposite directions (the two sides of
 * one road through the junction) share a phase; every other approach gets a
 * phase of its own. Each phase is a list of indices into `approaches`, in
 * approach order, so the plan is deterministic.
 */
export function defaultPhases(approaches: readonly JunctionLane[]): number[][] {
  const used = new Set<number>()
  const phases: number[][] = []
  for (let i = 0; i < approaches.length; i++) {
    if (used.has(i)) continue
    used.add(i)
    const phase = [i]
    let best = -1
    let bestDiff = (3 * Math.PI) / 4
    for (let j = i + 1; j < approaches.length; j++) {
      if (used.has(j)) continue
      const diff = Math.abs(normalizeAngle(approaches[j]!.heading - approaches[i]!.heading))
      if (diff > bestDiff) {
        best = j
        bestDiff = diff
      }
    }
    if (best >= 0) {
      used.add(best)
      phase.push(best)
    }
    phases.push(phase)
  }
  return phases
}

/** Where a fixed-time signal is in its cycle at `elapsed` seconds after it started. */
export function signalPhaseAt(
  phaseCount: number,
  greenSec: number,
  elapsed: number,
  clearanceSec = SIGNAL_CLEARANCE_SEC,
): { phase: number; clearance: boolean; remaining: number } {
  if (phaseCount <= 0) return { phase: 0, clearance: true, remaining: Infinity }
  const slot = greenSec + clearanceSec
  const t = ((elapsed % (slot * phaseCount)) + slot * phaseCount) % (slot * phaseCount)
  const phase = Math.min(phaseCount - 1, Math.floor(t / slot + 1e-9))
  const within = t - phase * slot
  const clearance = within >= greenSec - 1e-9
  return { phase, clearance, remaining: clearance ? slot - within : greenSec - within }
}

/**
 * Light shown to approach `index`: green during its phase, amber during the
 * clearance that ends its phase, red otherwise. Only green admits vehicles.
 */
export function lightFor(phases: readonly (readonly number[])[], index: number, state: { phase: number; clearance: boolean }): SignalLight {
  const mine = phases[state.phase]?.includes(index) ?? false
  if (!mine) return 'red'
  return state.clearance ? 'amber' : 'green'
}
