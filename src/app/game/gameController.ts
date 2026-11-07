import { shallowRef, type ShallowRef } from 'vue'
import {
  ConstructionController,
  GameSession,
  type ConstructionTarget,
  type EditResult,
  type NodeId,
  type GameMode,
  type WorldTheme,
  type Point,
  type SessionSnapshot,
  type SessionState,
  type GameSaveData,
  type ShopItemId,
} from '@game/index'

/** What pointer input on the map does: build roads, place traffic lights (#32) or roundabouts, or remove roads (#33). */
export type Tool = 'road' | 'signal' | 'roundabout' | 'remove'

/** How far (tiles) from a player road a tap still selects it. */
export const ROAD_TAP_DISTANCE = 0.8

export type RoadTapResult = 'selected' | 'generated' | 'none' | 'unavailable'

/** How far (tiles) from a junction's centre a tap still selects it. */
export const SIGNAL_TAP_DISTANCE = 1.6

/**
 * 'unowned': nothing of that kind in the inventory (buy one in the shop);
 * 'occupied': the junction already has the other kind of control.
 */
export type SignalTapResult = 'placed' | 'selected' | 'none' | 'unavailable' | 'unowned' | 'occupied'

/** States in which the player may build roads (#7 contract). */
export function canBuild(state: SessionState): boolean {
  return state === 'running' || state === 'paused'
}

/**
 * Vue-facing wrapper around a GameSession. It owns no game rules: it exposes
 * the session's snapshot as reactive state, forwards lifecycle actions, keeps
 * a ConstructionController in step with the current level, and advances the
 * session from a frame callback.
 */
export interface GameController {
  readonly session: ShallowRef<GameSession>
  readonly snapshot: ShallowRef<SessionSnapshot>
  readonly construction: ShallowRef<ConstructionController>
  readonly tool: ShallowRef<Tool>
  /** Node of the traffic signal being edited, if any. */
  readonly selectedSignal: ShallowRef<NodeId | undefined>
  setTool(tool: Tool): void
  /** Places lights on the junction at `point`, or selects the lights already there. */
  tapSignal(point: Point): SignalTapResult
  /** Sets the selected lights' green time (seconds). */
  setSignalGreen(greenSec: number): void
  removeSelectedSignal(): void
  /** Node of the roundabout being edited, if any. */
  readonly selectedRoundabout: ShallowRef<NodeId | undefined>
  /** Builds a roundabout on the junction at `point`, or selects the one there. */
  tapRoundabout(point: Point): SignalTapResult
  removeSelectedRoundabout(): void
  /** Buys one shop item; returns whether it was bought. */
  buy(item: ShopItemId): boolean
  /** Id of the player road selected for removal, if any (#33). */
  readonly selectedRoad: ShallowRef<number | undefined>
  /** Selects the player road at `point` (with the remove tool). */
  tapRoad(point: Point): RoadTapResult
  removeSelectedRoad(): EditResult | undefined
  undo(): EditResult | undefined
  redo(): EditResult | undefined
  start(): void
  pause(): void
  resume(): void
  togglePause(): void
  restart(): void
  nextLevel(): void
  /** Replaces the run with a new seed (same mode) and starts it. */
  newGame(seed: number | string): void
  saveData(): GameSaveData
  loadSave(data: unknown): void
  /** Advances real time (seconds) and refreshes the snapshot. */
  frame(elapsedSec: number): void
  dispose(): void
}

export function createGameController(seed: number | string, mode: GameMode = 'classic', theme: WorldTheme = 'countryside'): GameController {
  let currentMode = mode
  let currentTheme = theme
  const session = shallowRef(new GameSession({ seed, mode, world: { theme } }))
  const snapshot = shallowRef(session.value.snapshot())
  const construction = shallowRef(makeConstruction(session.value))
  const tool = shallowRef<Tool>('road')
  const selectedSignal = shallowRef<NodeId | undefined>(undefined)
  const selectedRoundabout = shallowRef<NodeId | undefined>(undefined)
  const selectedRoad = shallowRef<number | undefined>(undefined)
  let unsubscribe = bind(session.value)

  function makeConstruction(s: GameSession): ConstructionController {
    return new ConstructionController(s.world, s.graph, undefined, (from, to: ConstructionTarget, via) =>
      to.kind === 'point' ? s.connectRoadToPoint(from, to.position, undefined, via) : s.connectRoad(from, to, undefined, via))
  }

  function bind(s: GameSession): () => void {
    return s.subscribe((event) => {
      if (event.type !== 'stateChange') return
      // restart()/nextLevel() load a new world and graph.
      if (construction.value.world !== s.world || construction.value.graph !== s.graph) {
        construction.value = makeConstruction(s)
        selectedSignal.value = undefined
        selectedRoundabout.value = undefined
        selectedRoad.value = undefined
      }
      if (!canBuild(event.to)) construction.value.cancel()
      snapshot.value = s.snapshot()
    })
  }

  const act = (fn: (s: GameSession) => unknown) => () => {
    fn(session.value)
    snapshot.value = session.value.snapshot()
  }

  const refresh = () => {
    snapshot.value = session.value.snapshot()
  }

  return {
    session,
    snapshot,
    construction,
    tool,
    selectedSignal,
    selectedRoundabout,
    setTool(next) {
      if (tool.value === next) return
      construction.value.cancel()
      selectedSignal.value = undefined
      selectedRoundabout.value = undefined
      selectedRoad.value = undefined
      tool.value = next
    },
    selectedRoad,
    tapRoad(point) {
      const s = session.value
      if (!canBuild(s.state)) return 'unavailable'
      const road = s.roadAt(point, ROAD_TAP_DISTANCE)
      selectedRoad.value = road?.state === 'open' ? road.id : undefined
      if (road) return 'selected'
      // Generated roads cannot be removed; say so rather than ignoring the tap.
      return s.graph.nearestLocation(point, ROAD_TAP_DISTANCE) ? 'generated' : 'none'
    },
    removeSelectedRoad() {
      const id = selectedRoad.value
      if (id === undefined || !canBuild(session.value.state)) return undefined
      const result = session.value.removeRoad(id)
      selectedRoad.value = undefined
      refresh()
      return result
    },
    undo() {
      if (!canBuild(session.value.state)) return undefined
      construction.value.cancel()
      selectedRoad.value = undefined
      const result = session.value.undo()
      refresh()
      return result
    },
    redo() {
      if (!canBuild(session.value.state)) return undefined
      construction.value.cancel()
      selectedRoad.value = undefined
      const result = session.value.redo()
      refresh()
      return result
    },
    tapSignal(point) {
      const s = session.value
      if (!canBuild(s.state)) return 'unavailable'
      const junction = s.sim.signalJunctionNear(point, SIGNAL_TAP_DISTANCE)
      if (!junction) {
        selectedSignal.value = undefined
        return 'none'
      }
      const existing = s.sim.signalAt(junction.key)
      if (existing) {
        selectedSignal.value = existing.node
        return 'selected'
      }
      selectedSignal.value = undefined
      if (s.sim.roundaboutAt(junction.key)) return 'occupied'
      if (s.owns('signal') <= 0) return 'unowned'
      if (!s.placeSignal(junction.key)) return 'none'
      selectedSignal.value = junction.key
      refresh()
      return 'placed'
    },
    tapRoundabout(point) {
      const s = session.value
      if (!canBuild(s.state)) return 'unavailable'
      const junction = s.sim.signalJunctionNear(point, SIGNAL_TAP_DISTANCE)
      selectedRoundabout.value = undefined
      if (!junction) return 'none'
      if (s.sim.roundaboutAt(junction.key)) {
        selectedRoundabout.value = junction.key
        return 'selected'
      }
      if (s.sim.signalAt(junction.key)) return 'occupied'
      if (s.owns('roundabout') <= 0) return 'unowned'
      if (!s.placeRoundabout(junction.key)) return 'none'
      selectedRoundabout.value = junction.key
      refresh()
      return 'placed'
    },
    removeSelectedRoundabout() {
      const node = selectedRoundabout.value
      if (node === undefined || !canBuild(session.value.state)) return
      session.value.removeRoundabout(node)
      selectedRoundabout.value = undefined
      refresh()
    },
    buy(item) {
      const ok = session.value.buy(item)
      refresh()
      return ok
    },
    setSignalGreen(greenSec) {
      const node = selectedSignal.value
      if (node === undefined || !canBuild(session.value.state)) return
      session.value.placeSignal(node, { greenSec })
      refresh()
    },
    removeSelectedSignal() {
      const node = selectedSignal.value
      if (node === undefined || !canBuild(session.value.state)) return
      session.value.removeSignal(node)
      selectedSignal.value = undefined
      refresh()
    },
    start: act((s) => s.start()),
    pause: act((s) => s.pause()),
    resume: act((s) => s.resume()),
    togglePause: act((s) => (s.state === 'paused' ? s.resume() : s.pause())),
    restart: act((s) => s.restart()),
    nextLevel: act((s) => s.nextLevel()),
    saveData() {
      return session.value.toSaveData()
    },
    loadSave(data) {
      const restored = GameSession.fromSaveData(data)
      unsubscribe()
      session.value = restored
      currentMode = restored.mode
      currentTheme = restored.world.theme
      construction.value = makeConstruction(restored)
      selectedSignal.value = undefined
      selectedRoundabout.value = undefined
      selectedRoad.value = undefined
      tool.value = 'road'
      unsubscribe = bind(restored)
      snapshot.value = restored.snapshot()
    },
    newGame(nextSeed) {
      unsubscribe()
      session.value = new GameSession({ seed: nextSeed, mode: currentMode, world: { theme: currentTheme } })
      construction.value = makeConstruction(session.value)
      selectedSignal.value = undefined
      selectedRoundabout.value = undefined
      selectedRoad.value = undefined
      unsubscribe = bind(session.value)
      session.value.start()
      snapshot.value = session.value.snapshot()
    },
    frame(elapsedSec) {
      session.value.update(elapsedSec)
      snapshot.value = session.value.snapshot()
    },
    dispose() {
      unsubscribe()
    },
  }
}
