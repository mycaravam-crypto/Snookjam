import { describe, expect, it } from 'vitest'
import {
  EMPTY_NETWORK_STATS,
  evaluateObjective,
  GameSession,
  LEVEL_OBJECTIVES,
  levelScore,
  objectivesFor,
  type NetworkStats,
  type ObjectiveDef,
  type SessionEvent,
} from '../../../src/game'

const DT = 1 / 20
const stats = (o: Partial<NetworkStats>): NetworkStats => ({ ...EMPTY_NETWORK_STATS, ...o })

function run(s: GameSession, seconds: number, holdCongestion = false): void {
  for (let i = 0; i < Math.round(seconds / DT) && s.state === 'running'; i++) {
    s.tick(DT)
    if (holdCongestion) s.setCongestionForTesting(0)
  }
}

describe('objective definitions', () => {
  it('only apply in objectives mode and scale journeys beyond the table', () => {
    expect(objectivesFor('classic', 1)).toEqual([])
    expect(objectivesFor('sandbox', 3)).toEqual([])
    expect(objectivesFor('objectives', 1)).toEqual(LEVEL_OBJECTIVES[0])
    const last = LEVEL_OBJECTIVES[LEVEL_OBJECTIVES.length - 1]!
    const beyond = objectivesFor('objectives', LEVEL_OBJECTIVES.length + 2)
    expect(beyond.find((d) => d.kind === 'journeys')!.target).toBe(last.find((d) => d.kind === 'journeys')!.target + 20)
  })
})

describe('evaluateObjective', () => {
  it('meets a journeys goal as soon as it is reached and fails it only at the end', () => {
    const def: ObjectiveDef = { kind: 'journeys', target: 10 }
    expect(evaluateObjective(def, stats({ completedJourneys: 4 }), false)).toMatchObject({ status: 'pending', progress: 0.4, onTrack: false })
    expect(evaluateObjective(def, stats({ completedJourneys: 4 }), true)).toMatchObject({ status: 'failed' })
    expect(evaluateObjective(def, stats({ completedJourneys: 12 }), false)).toMatchObject({ status: 'met', progress: 1 })
  })

  it('judges throughput and waiting time at the end, tracking them meanwhile', () => {
    const tp: ObjectiveDef = { kind: 'throughput', target: 30 }
    expect(evaluateObjective(tp, stats({}), false)).toMatchObject({ value: undefined, progress: 0, status: 'pending', onTrack: false })
    expect(evaluateObjective(tp, stats({ throughputPerMin: 33 }), false)).toMatchObject({ onTrack: true, status: 'pending' })
    expect(evaluateObjective(tp, stats({ throughputPerMin: 33 }), true).status).toBe('met')
    expect(evaluateObjective(tp, stats({ throughputPerMin: 15 }), true)).toMatchObject({ status: 'failed', progress: 0.5 })

    const wait: ObjectiveDef = { kind: 'averageWait', target: 6 }
    expect(evaluateObjective(wait, stats({}), true).status).toBe('failed') // no journeys to judge
    expect(evaluateObjective(wait, stats({ averageWaitSec: 6 }), true)).toMatchObject({ status: 'met', progress: 1 })
    expect(evaluateObjective(wait, stats({ averageWaitSec: 12 }), true)).toMatchObject({ status: 'failed', progress: 0.5 })
  })

  it('scores 10 per journey and 50 per objective met', () => {
    expect(levelScore(0, 0)).toBe(0)
    expect(levelScore(73, 2)).toBe(830)
  })
})

describe('GameSession modes', () => {
  it('classic mode has no objectives and keeps the survival lifecycle', () => {
    const s = new GameSession({ seed: 42 })
    s.start()
    run(s, 180, true)
    expect(s.state).toBe('levelComplete')
    const snap = s.snapshot()
    expect(snap.mode).toBe('classic')
    expect(snap.objectives).toEqual([])
    expect(snap.score).toBe(10 * snap.network.completedJourneys)
  })

  it('objectives mode completes the level when every goal is met and banks the score', () => {
    const s = new GameSession({ seed: 42, mode: 'objectives', objectives: [[{ kind: 'journeys', target: 20 }]] })
    s.start()
    run(s, 60, true)
    expect(s.snapshot().objectives[0]!.status).toBe('met')
    run(s, 120, true)
    expect(s.state).toBe('levelComplete')
    const done = s.snapshot()
    expect(done.levelScore).toBe(10 * done.network.completedJourneys + 50)
    expect(done.score).toBe(done.levelScore)
    s.nextLevel()
    expect(s.snapshot().score).toBe(done.score)
    expect(s.snapshot().levelScore).toBe(0)
  })

  it('objectives mode ends the run when a goal is missed at the timer', () => {
    const s = new GameSession({ seed: 42, mode: 'objectives', objectives: [[{ kind: 'journeys', target: 20 }, { kind: 'throughput', target: 999 }]] })
    const events: SessionEvent[] = []
    s.subscribe((e) => events.push(e))
    s.start()
    run(s, 179, true)
    expect(s.state).toBe('running')
    expect(s.snapshot().objectives.map((o) => o.status)).toEqual(['met', 'pending'])
    run(s, 2, true)
    expect(s.state).toBe('gameOver')
    const snap = s.snapshot()
    expect(snap.endReason).toBe('objectives')
    expect(snap.objectives.map((o) => o.status)).toEqual(['met', 'failed'])
    expect(snap.score).toBe(10 * snap.network.completedJourneys + 50)
    expect(events.find((e) => e.type === 'gameOver')).toMatchObject({ reason: 'objectives', level: 1 })
    s.restart()
    expect(s.snapshot()).toMatchObject({ score: 0, endReason: undefined, state: 'running' })
    expect(s.snapshot().objectives.map((o) => o.status)).toEqual(['pending', 'pending'])
  })

  it('reports gridlock as the end reason in objectives mode too', () => {
    const s = new GameSession({ seed: 42, mode: 'objectives' })
    s.start()
    run(s, 5)
    s.setCongestionForTesting(100)
    s.tick(DT)
    expect(s.snapshot()).toMatchObject({ state: 'gameOver', endReason: 'congestion' })
  })

  it('sandbox mode has no timer and no gridlock loss', () => {
    const s = new GameSession({ seed: 42, mode: 'sandbox' })
    s.start()
    run(s, 200)
    s.setCongestionForTesting(100)
    s.tick(DT)
    expect(s.state).toBe('running')
    expect(s.snapshot().congestion).toBeGreaterThan(99)
    run(s, 30)
    const snap = s.snapshot()
    expect(snap.state).toBe('running')
    expect(snap.levelTime).toBeCloseTo(230 + DT)
    expect(snap.objectives).toEqual([])
  })

  it('is deterministic for a seed and step sequence', () => {
    const play = () => {
      const s = new GameSession({ seed: 9, mode: 'objectives' })
      s.start()
      run(s, 181, true)
      return JSON.stringify(s.snapshot())
    }
    expect(play()).toBe(play())
  })
})
