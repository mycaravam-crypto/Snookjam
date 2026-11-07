/**
 * Level objectives, scoring and game modes (#35).
 *
 * Objectives are plain data evaluated against the traffic diagnostics
 * (#34), so they are deterministic for a given seed and input sequence.
 *
 * Objective kinds (all judged when the level timer runs out):
 *
 * - `journeys`: at least `target` vehicles reached their destination tunnel
 *   this level. Met as soon as the count is reached.
 * - `throughput`: at least `target` journeys per minute over the last 60 s
 *   (the diagnostics throughput metric).
 * - `averageWait`: the average waiting time of journeys completed this level
 *   is at most `target` seconds. Needs at least one completed journey.
 *
 * Score: each completed journey is worth `POINTS_PER_JOURNEY` (10) and each
 * objective met at the end of a level `POINTS_PER_OBJECTIVE` (50). There are
 * no other bonuses. The run score is the sum over levels.
 *
 * Modes:
 *
 * - `classic`: survive the level timer below 100% congestion (#7).
 * - `objectives`: as classic, and every objective must be met when the timer
 *   runs out; otherwise the run ends.
 * - `sandbox`: no timer, no objectives and no gridlock loss; congestion and
 *   statistics are still shown. Construction is unlimited in every mode.
 */
import type { NetworkStats } from '../diagnostics'

export type GameMode = 'classic' | 'objectives' | 'sandbox'
export const GAME_MODES: readonly GameMode[] = ['classic', 'objectives', 'sandbox']

export type ObjectiveKind = 'journeys' | 'throughput' | 'averageWait'

export interface ObjectiveDef {
  readonly kind: ObjectiveKind
  readonly target: number
}

export type ObjectiveStatus = 'pending' | 'met' | 'failed'

export interface ObjectiveProgress {
  readonly kind: ObjectiveKind
  readonly target: number
  /** Current value of the measured metric (undefined until measurable). */
  readonly value: number | undefined
  /** 0–1 towards meeting the objective (for progress bars). */
  readonly progress: number
  /** Whether the objective would be met if the level ended now. */
  readonly onTrack: boolean
  readonly status: ObjectiveStatus
}

export const POINTS_PER_JOURNEY = 10
export const POINTS_PER_OBJECTIVE = 50

/**
 * Objectives per level, tuned on generated maps without player roads
 * (10 seeds): level 1 averages ~80 journeys, so it is met by default; level 2
 * waits average 4–7 s; level 3 tops out near 110 journeys at ~38/min and
 * needs relief roads; from level 4 the network gridlocks unless improved.
 */
export const LEVEL_OBJECTIVES: readonly (readonly ObjectiveDef[])[] = Object.freeze([
  [{ kind: 'journeys', target: 70 }],
  [
    { kind: 'journeys', target: 95 },
    { kind: 'averageWait', target: 6 },
  ],
  [
    { kind: 'journeys', target: 110 },
    { kind: 'throughput', target: 38 },
  ],
  [
    { kind: 'journeys', target: 110 },
    { kind: 'averageWait', target: 15 },
  ],
])

/** Objectives for a level in a mode; later levels extend the last entry. */
export function objectivesFor(mode: GameMode, level: number, table: readonly (readonly ObjectiveDef[])[] = LEVEL_OBJECTIVES): readonly ObjectiveDef[] {
  if (mode !== 'objectives' || table.length === 0) return []
  const index = Math.max(0, Math.floor(level) - 1)
  if (index < table.length) return table[index]!
  const extra = index - (table.length - 1)
  return table[table.length - 1]!.map((d) => (d.kind === 'journeys' ? { kind: d.kind, target: d.target + 10 * extra } : d))
}

/** Evaluates one objective; `finished` is true once the level timer ran out. */
export function evaluateObjective(def: ObjectiveDef, stats: NetworkStats, finished: boolean): ObjectiveProgress {
  let value: number | undefined
  let onTrack: boolean
  let progress: number
  switch (def.kind) {
    case 'journeys':
      value = stats.completedJourneys
      onTrack = value >= def.target
      progress = def.target > 0 ? Math.min(1, value / def.target) : 1
      break
    case 'throughput':
      value = stats.throughputPerMin
      onTrack = value !== undefined && value + 1e-9 >= def.target
      progress = value === undefined ? 0 : def.target > 0 ? Math.min(1, value / def.target) : 1
      break
    case 'averageWait':
      value = stats.averageWaitSec
      onTrack = value !== undefined && value <= def.target + 1e-9
      // Full while within the limit, shrinking as the average exceeds it.
      progress = value === undefined ? 0 : value <= def.target ? 1 : Math.max(0, def.target / value)
      break
  }
  // Journeys can never be lost once reached; the others are judged at the end.
  const status: ObjectiveStatus =
    def.kind === 'journeys' && onTrack ? 'met' : finished ? (onTrack ? 'met' : 'failed') : 'pending'
  return { kind: def.kind, target: def.target, value, progress, onTrack, status }
}

export function evaluateObjectives(defs: readonly ObjectiveDef[], stats: NetworkStats, finished: boolean): ObjectiveProgress[] {
  return defs.map((d) => evaluateObjective(d, stats, finished))
}

/** Points for one level: journeys plus objectives met (see module docs). */
export function levelScore(journeys: number, objectivesMet: number): number {
  return POINTS_PER_JOURNEY * journeys + POINTS_PER_OBJECTIVE * objectivesMet
}
