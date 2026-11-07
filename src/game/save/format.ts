/**
 * Versioned save format (#36).
 *
 * A save does not copy simulation internals. It stores the run's inputs:
 * the seed, mode and level, the scalar run totals from earlier levels, and
 * every player action in the current level with the simulation step it was
 * applied before. Loading replays those inputs in a fresh session; because
 * world generation, routing and traffic are deterministic for a seed and
 * step sequence, this restores vehicle positions, routes, lanes, signals and
 * random-generator state exactly. A fingerprint of the saved state is
 * checked after the replay, so a save that no longer reproduces (for example
 * after a game update changed the simulation) is rejected instead of loading
 * a different game.
 *
 * Validation is strict and happens before anything touches the active game.
 */
import type { NodeId, Point, RoadLocation } from '../roads'
import { GAME_MODES, type GameMode } from '../session/objectives'

export const SAVE_FORMAT = 'snookjam-save'
export const SAVE_VERSION = 1

/** A player action recorded for replay. */
export type SaveAction =
  | { readonly type: 'connect'; readonly from: RoadLocation; readonly to: RoadLocation; readonly via: readonly Point[] }
  | { readonly type: 'connectToPoint'; readonly from: RoadLocation; readonly point: Point; readonly via: readonly Point[] }
  | { readonly type: 'placeSignal'; readonly node: NodeId; readonly greenSec?: number }
  | { readonly type: 'removeSignal'; readonly node: NodeId }
  | { readonly type: 'removeRoad'; readonly id: number }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }

export interface TimedAction {
  /** Simulation steps run in this level before the action was applied. */
  readonly tick: number
  readonly action: SaveAction
}

export interface SaveData {
  readonly format: typeof SAVE_FORMAT
  readonly version: typeof SAVE_VERSION
  /** ISO timestamp, for display only. */
  readonly savedAt: string
  readonly seed: number
  readonly mode: GameMode
  readonly level: number
  /** Simulation step length the ticks were recorded with. */
  readonly stepSec: number
  /** Steps run in the current level. */
  readonly ticks: number
  /** Run totals from completed levels. */
  readonly completedTime: number
  readonly completedScore: number
  readonly exitedBeforeLevel: number
  readonly actions: readonly TimedAction[]
  /** Fingerprint of the saved state; the replay must reproduce it. */
  readonly fingerprint: string
}

export type SaveErrorCode = 'corrupt' | 'unsupported-version' | 'invalid' | 'mismatch' | 'storage-unavailable' | 'storage-full' | 'not-found'

export class SaveError extends Error {
  constructor(
    readonly code: SaveErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SaveError'
  }
}

/** Player-facing explanation for each error code. */
export const SAVE_ERROR_MESSAGES: Readonly<Record<SaveErrorCode, string>> = Object.freeze({
  corrupt: 'The saved game is damaged and could not be read.',
  'unsupported-version': 'The saved game is from a different version of Snookjam and cannot be loaded.',
  invalid: 'The saved game contains invalid data.',
  mismatch: 'The saved game no longer matches this version of Snookjam and cannot be restored.',
  'storage-unavailable': 'Saving is unavailable in this browser (storage is blocked or disabled).',
  'storage-full': 'There is not enough browser storage to save the game.',
  'not-found': 'There is no saved game.',
})

const MAX_ACTIONS = 10_000
const MAX_POINTS = 10_000

/** Parses and validates a save; throws SaveError. Never returns partial data. */
export function parseSave(text: string): SaveData {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new SaveError('corrupt', 'save is not valid JSON')
  }
  if (!isRecord(raw) || raw.format !== SAVE_FORMAT) throw new SaveError('corrupt', 'not a Snookjam save')
  if (raw.version !== SAVE_VERSION) {
    throw new SaveError('unsupported-version', `save version ${String(raw.version)} is not supported (expected ${SAVE_VERSION})`)
  }
  return validateSave(raw)
}

export function serializeSave(data: SaveData): string {
  return JSON.stringify(data)
}

function validateSave(r: Record<string, unknown>): SaveData {
  const fail = (what: string): never => {
    throw new SaveError('invalid', `invalid ${what}`)
  }
  const savedAt = typeof r.savedAt === 'string' ? r.savedAt : fail('savedAt')
  const seed = isUint32(r.seed) ? r.seed : fail('seed')
  const mode = GAME_MODES.includes(r.mode as GameMode) ? (r.mode as GameMode) : fail('mode')
  const level = isInt(r.level) && r.level >= 1 && r.level <= 10_000 ? r.level : fail('level')
  const stepSec = isFiniteNumber(r.stepSec) && r.stepSec > 0 && r.stepSec <= 1 ? r.stepSec : fail('stepSec')
  const ticks = isInt(r.ticks) && r.ticks >= 0 && r.ticks <= 10_000_000 ? r.ticks : fail('ticks')
  const completedTime = isFiniteNumber(r.completedTime) && r.completedTime >= 0 ? r.completedTime : fail('completedTime')
  const completedScore = isInt(r.completedScore) && r.completedScore >= 0 ? r.completedScore : fail('completedScore')
  const exitedBeforeLevel = isInt(r.exitedBeforeLevel) && r.exitedBeforeLevel >= 0 ? r.exitedBeforeLevel : fail('exitedBeforeLevel')
  const fingerprint = typeof r.fingerprint === 'string' && r.fingerprint.length > 0 ? r.fingerprint : fail('fingerprint')

  if (!Array.isArray(r.actions) || r.actions.length > MAX_ACTIONS) fail('actions')
  let lastTick = 0
  const actions = (r.actions as unknown[]).map((entry, i) => {
    if (!isRecord(entry) || !isInt(entry.tick) || entry.tick < lastTick || entry.tick > ticks) fail(`action ${i} tick`)
    lastTick = (entry as { tick: number }).tick
    return { tick: lastTick, action: validateAction((entry as Record<string, unknown>).action) ?? fail(`action ${i}`) }
  })

  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt,
    seed,
    mode,
    level,
    stepSec,
    ticks,
    completedTime,
    completedScore,
    exitedBeforeLevel,
    actions,
    fingerprint,
  }
}

function validateAction(a: unknown): SaveAction | undefined {
  if (!isRecord(a)) return undefined
  switch (a.type) {
    case 'connect': {
      const from = location(a.from)
      const to = location(a.to)
      const via = points(a.via)
      return from && to && via ? { type: 'connect', from, to, via } : undefined
    }
    case 'connectToPoint': {
      const from = location(a.from)
      const via = points(a.via)
      return from && isPoint(a.point) && via ? { type: 'connectToPoint', from, point: { x: a.point.x, y: a.point.y }, via } : undefined
    }
    case 'placeSignal':
      if (!isInt(a.node) || a.node < 0) return undefined
      if (a.greenSec === undefined) return { type: 'placeSignal', node: a.node }
      return isFiniteNumber(a.greenSec) && a.greenSec > 0 ? { type: 'placeSignal', node: a.node, greenSec: a.greenSec } : undefined
    case 'removeSignal':
      return isInt(a.node) && a.node >= 0 ? { type: 'removeSignal', node: a.node } : undefined
    case 'removeRoad':
      return isInt(a.id) && a.id >= 0 ? { type: 'removeRoad', id: a.id } : undefined
    case 'undo':
    case 'redo':
      return { type: a.type }
    default:
      return undefined
  }
}

function location(v: unknown): RoadLocation | undefined {
  if (!isRecord(v)) return undefined
  if (v.kind === 'node' && isInt(v.node) && v.node >= 0) return { kind: 'node', node: v.node }
  if (v.kind === 'edge' && isInt(v.edge) && v.edge >= 0 && isFiniteNumber(v.t) && v.t >= 0 && v.t <= 1) {
    return { kind: 'edge', edge: v.edge, t: v.t }
  }
  return undefined
}

function points(v: unknown): Point[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_POINTS || !v.every(isPoint)) return undefined
  return v.map((p: Point) => ({ x: p.x, y: p.y }))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isInt(v: unknown): v is number {
  return Number.isSafeInteger(v)
}

function isUint32(v: unknown): v is number {
  return isInt(v) && v >= 0 && v <= 0xffffffff
}

function isPoint(v: unknown): v is Point {
  return isRecord(v) && isFiniteNumber(v.x) && isFiniteNumber(v.y)
}
