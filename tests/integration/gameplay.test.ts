/**
 * End-to-end gameplay integration (#9) without a browser: world generation,
 * road graph, routing, traffic, player construction and congestion working
 * together under fixed seeds and fixed steps (no wall-clock timing).
 *
 * Scenario: seed 77, level 3. Without player roads, the level is lost before
 * the 180 s target. One road from (23.5, 7.5) to (22.5, 13.5), built 12 s
 * into the level, relieves the bottleneck and the level is completed. This
 * scenario was found by trying every valid single road on that map; if world
 * generation or balance changes, re-run that search and update it.
 */
import { describe, expect, it } from 'vitest'
import { ConstructionController, GameSession, type SessionEvent } from '../../src/game'

const SEED = 77
const ROAD = { from: { x: 23.5, y: 7.5 }, to: { x: 22.5, y: 13.5 } }
const BUILD_AT_SEC = 12
const DT = 1 / 20

/** Plays levels 1 and 2 without building; returns the session at level 3 start. */
function reachLevel3(events: SessionEvent[] = []): GameSession {
  const s = new GameSession({ seed: SEED })
  s.subscribe((e) => events.push(e))
  s.start()
  for (let level = 1; level < 3; level++) {
    while (s.state === 'running') s.tick(DT)
    expect(s.state).toBe('levelComplete')
    s.nextLevel()
  }
  expect(s.level).toBe(3)
  return s
}

function runLevel(s: GameSession, onTick?: () => void): { peak: number } {
  let peak = 0
  while (s.state === 'running') {
    s.tick(DT)
    peak = Math.max(peak, s.congestion)
    onTick?.()
  }
  return { peak }
}

/** Builds the scenario road through the same controller the canvas uses. */
function buildRoad(s: GameSession) {
  const controller = new ConstructionController(s.world, s.graph, undefined, (a, b) => s.connectRoad(a, b))
  expect(controller.pointerDown(ROAD.from)).toBe(true)
  controller.pointerMove(ROAD.to)
  const outcome = controller.pointerUp(ROAD.to)
  if (outcome.kind !== 'committed') throw new Error(`scenario road was not built: ${JSON.stringify(outcome)}`)
  return outcome.result
}

describe('gameplay integration (seed 77)', () => {
  it('generates a playable map whose portals are all connected', () => {
    const s = new GameSession({ seed: SEED })
    expect(s.world.portals.length).toBeGreaterThanOrEqual(2)
    expect(s.world.generation.fallback).toBe(false)
    s.start()
    for (let i = 0; i < 60 / DT; i++) s.tick(DT)
    expect(s.sim.stats()).toMatchObject({ totalUnroutable: 0, stuck: 0 })
    expect(s.snapshot().vehiclesExited).toBeGreaterThan(0)
  })

  it('loses level 3 when the player builds nothing', () => {
    const events: SessionEvent[] = []
    const s = reachLevel3(events)
    const { peak } = runLevel(s)
    expect(s.state).toBe('gameOver')
    expect(peak).toBe(100)
    expect(s.snapshot().levelTime).toBeLessThan(s.balance.levelDurationSec)
    expect(events.filter((e) => e.type === 'gameOver')).toHaveLength(1)
  })

  it('completes level 3 after building one relieving road', () => {
    const s = reachLevel3()
    let builtEdge = -1
    const usedBy = new Set<number>()
    const { peak } = runLevel(s, () => {
      if (builtEdge < 0 && s.snapshot().levelTime >= BUILD_AT_SEC) builtEdge = buildRoad(s).edge
      if (builtEdge >= 0) for (const v of s.sim.vehicles()) if (v.steps.some((step) => step.edge === builtEdge)) usedBy.add(v.id)
    })
    expect(s.state).toBe('levelComplete')
    expect(peak).toBeLessThan(s.balance.criticalThreshold)
    // Rerouted traffic actually uses the new road.
    expect(usedBy.size).toBeGreaterThan(10)
  })

  it('moves more traffic through the network with the new road', () => {
    const measure = (build: boolean) => {
      const s = reachLevel3()
      const exitedBefore = s.snapshot().vehiclesExited
      for (let i = 0; i < 120 / DT && s.state === 'running'; i++) {
        if (build && i === BUILD_AT_SEC / DT) buildRoad(s)
        s.tick(DT)
      }
      return { exited: s.snapshot().vehiclesExited - exitedBefore, congestion: s.congestion }
    }
    const without = measure(false)
    const withRoad = measure(true)
    expect(withRoad.exited).toBeGreaterThan(without.exited)
    expect(withRoad.congestion).toBeLessThan(without.congestion)
  })

  it('restarts after a lost run with no built roads, vehicles or time carried over', () => {
    const s = reachLevel3()
    for (let i = 0; i < 20 / DT; i++) {
      if (i === BUILD_AT_SEC / DT) buildRoad(s)
      s.tick(DT)
    }
    s.pause()
    s.setCongestionForTesting(100)
    s.resume()
    s.tick(DT)
    expect(s.state).toBe('gameOver')

    s.restart()
    const fresh = new GameSession({ seed: SEED })
    fresh.start()
    expect(s.graph.edgeCount).toBe(fresh.graph.edgeCount)
    expect(s.graph.nodeCount).toBe(fresh.graph.nodeCount)
    for (let i = 0; i < 30 / DT; i++) {
      s.tick(DT)
      fresh.tick(DT)
    }
    expect(s.snapshot()).toEqual(fresh.snapshot())
    expect(JSON.stringify(s.sim.vehicles())).toBe(JSON.stringify(fresh.sim.vehicles()))
  })
})

describe('simulation performance at the MVP target scale', () => {
  it('steps 100 active vehicles on a generated map well within the 50 ms frame budget', () => {
    const s = new GameSession({ seed: SEED, balance: { startingVehicles: 100, baseSpawnIntervalSec: 0.8, levelStartGraceSec: 1e9 } })
    s.start()
    for (let i = 0; i < 60 / DT; i++) s.tick(DT) // fill the map
    const active = s.snapshot().activeVehicles
    const steps = 20 * 30
    const start = performance.now()
    for (let i = 0; i < steps; i++) s.tick(DT)
    const perStepMs = (performance.now() - start) / steps
    console.info(`perf: ${active} active vehicles, ${perStepMs.toFixed(3)} ms per 50 ms step`)
    expect(active).toBeGreaterThanOrEqual(90)
    // Generous bound for slow CI machines; locally this is well under 1 ms.
    expect(perStepMs).toBeLessThan(5)
  })
})
