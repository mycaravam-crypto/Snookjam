import { shallowRef, type ShallowRef } from 'vue'
import {
  ConstructionController,
  GameSession,
  type ConstructionTarget,
  type NodeId,
  type GameMode,
  type Point,
  type SessionSnapshot,
  type SessionState,
} from '@game/index'

/** What pointer input on the map does: build roads, or place traffic lights (#32). */
export type Tool = 'road' | 'signal'

/** How far (tiles) from a junction's centre a tap still selects it. */
export const SIGNAL_TAP_DISTANCE = 1.6

export type SignalTapResult = 'placed' | 'selected' | 'none' | 'unavailable'

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
  start(): void
  pause(): void
  resume(): void
  togglePause(): void
  restart(): void
  nextLevel(): void
  /** Replaces the run with a new seed (same mode) and starts it. */
  newGame(seed: number | string): void
  /** Advances real time (seconds) and refreshes the snapshot. */
  frame(elapsedSec: number): void
  dispose(): void
}

export function createGameController(seed: number | string, mode: GameMode = 'classic'): GameController {
  const session = shallowRef(new GameSession({ seed, mode }))
  const snapshot = shallowRef(session.value.snapshot())
  const construction = shallowRef(makeConstruction(session.value))
  const tool = shallowRef<Tool>('road')
  const selectedSignal = shallowRef<NodeId | undefined>(undefined)
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
    setTool(next) {
      if (tool.value === next) return
      construction.value.cancel()
      selectedSignal.value = undefined
      tool.value = next
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
      s.placeSignal(junction.key)
      selectedSignal.value = junction.key
      refresh()
      return 'placed'
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
    newGame(nextSeed) {
      unsubscribe()
      session.value = new GameSession({ seed: nextSeed, mode })
      construction.value = makeConstruction(session.value)
      selectedSignal.value = undefined
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
