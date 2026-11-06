import { shallowRef, type ShallowRef } from 'vue'
import { ConstructionController, GameSession, type ConstructionTarget, type SessionSnapshot, type SessionState } from '@game/index'

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
  start(): void
  pause(): void
  resume(): void
  togglePause(): void
  restart(): void
  nextLevel(): void
  /** Replaces the run with a new seed and starts it. */
  newGame(seed: number | string): void
  /** Advances real time (seconds) and refreshes the snapshot. */
  frame(elapsedSec: number): void
  dispose(): void
}

export function createGameController(seed: number | string): GameController {
  const session = shallowRef(new GameSession({ seed }))
  const snapshot = shallowRef(session.value.snapshot())
  const construction = shallowRef(makeConstruction(session.value))
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
      }
      if (!canBuild(event.to)) construction.value.cancel()
      snapshot.value = s.snapshot()
    })
  }

  const act = (fn: (s: GameSession) => unknown) => () => {
    fn(session.value)
    snapshot.value = session.value.snapshot()
  }

  return {
    session,
    snapshot,
    construction,
    start: act((s) => s.start()),
    pause: act((s) => s.pause()),
    resume: act((s) => s.resume()),
    togglePause: act((s) => (s.state === 'paused' ? s.resume() : s.pause())),
    restart: act((s) => s.restart()),
    nextLevel: act((s) => s.nextLevel()),
    newGame(nextSeed) {
      unsubscribe()
      session.value = new GameSession({ seed: nextSeed })
      construction.value = makeConstruction(session.value)
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
