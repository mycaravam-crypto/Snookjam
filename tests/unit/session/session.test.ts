import { describe, expect, it } from 'vitest'
import { checkConnection, ConstructionController, GameSession, type SessionEvent, type SessionOptions } from '../../../src/game'
import { maxVehiclesFor, targetVehiclesFor } from '../../../src/game/session/balance'

const DT = 1 / 20

function session(options: Partial<SessionOptions> = {}) {
  const s = new GameSession({ seed: 42, ...options })
  const events: SessionEvent[] = []
  s.subscribe((e) => events.push(e))
  return { s, events }
}

function ticks(s: GameSession, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) s.tick(DT)
}

describe('traffic density progression', () => {
  it('starts with meaningful traffic and scales targets up to 400 vehicles', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(targetVehiclesFor)).toEqual([
      80, 120, 160, 220, 300, 400, 400, 400,
    ])
    const s = new GameSession({ seed: 42 })
    expect(s.snapshot()).toMatchObject({ activeVehicleTarget: 80, activeVehicles: 0, pendingVehicles: 16 })
    expect(s.sim.maxVehicles).toBe(80)
    expect(maxVehiclesFor(s.balance, 6)).toBe(400)
    expect(s.sim.spawnIntervalSec).toBeCloseTo(2.2)
    expect(s.world.settlements).toHaveLength(5)
    expect(s.world.portals).toHaveLength(4)
  })

  it('builds a visible active fleet quickly instead of trickling in a few cars', () => {
    const s = new GameSession({ seed: 42 })
    s.start()
    ticks(s, 10)
    expect(s.snapshot().activeVehicles).toBeGreaterThan(15)
    expect(s.snapshot().activeVehicleTarget).toBe(80)
  })
})

describe('GameSession lifecycle', () => {
  it('starts in ready and only advances while running', () => {
    const { s, events } = session()
    expect(s.state).toBe('ready')
    expect(s.update(1)).toBe(0)
    ticks(s, 1)
    expect(s.snapshot().levelTime).toBe(0)
    expect(s.start()).toBe(true)
    expect(s.start()).toBe(false)
    expect(events).toEqual([{ type: 'stateChange', from: 'ready', to: 'running' }])
    expect(s.update(0.5)).toBe(10)
    expect(s.snapshot().levelTime).toBeCloseTo(0.5)
  })

  it('freezes time, vehicles, spawning and congestion while paused', () => {
    const { s } = session()
    s.start()
    ticks(s, 20)
    s.setCongestionForTesting(40)
    expect(s.pause()).toBe(true)
    const before = { snap: s.snapshot(), vehicles: JSON.stringify(s.sim.vehicles()), stats: s.sim.stats() }
    expect(s.update(30)).toBe(0)
    ticks(s, 30)
    expect(s.snapshot()).toEqual(before.snap)
    expect(JSON.stringify(s.sim.vehicles())).toBe(before.vehicles)
    expect(s.sim.stats()).toEqual(before.stats)
    expect(s.pause()).toBe(false)
    expect(s.resume()).toBe(true)
    // Time spent paused is not caught up after resuming.
    expect(s.update(0.05)).toBe(1)
    expect(s.snapshot().levelTime).toBeCloseTo(20.05)
  })

  it('completes the level at the survival target and continues to the next', () => {
    const { s, events } = session({ balance: { levelDurationSec: 30 } })
    s.start()
    ticks(s, 29.9)
    expect(s.state).toBe('running')
    ticks(s, 0.1)
    expect(s.state).toBe('levelComplete')
    expect(events.filter((e) => e.type === 'levelComplete')).toEqual([{ type: 'levelComplete', level: 1, reward: expect.objectContaining({ coins: expect.any(Number) }) }])
    ticks(s, 5)
    expect(s.snapshot().levelTime).toBeCloseTo(30)

    const level1World = s.world.seed
    const exited = s.snapshot().vehiclesExited
    expect(s.nextLevel()).toBe(true)
    const snap = s.snapshot()
    expect(snap).toMatchObject({ state: 'running', level: 2, levelTime: 0, congestion: 0 })
    expect(snap.totalTime).toBeCloseTo(30)
    expect(snap.vehiclesExited).toBe(exited)
    expect(s.world.seed).not.toBe(level1World)
    expect(s.sim.spawnIntervalSec).toBeLessThan(s.balance.baseSpawnIntervalSec)
    expect(s.nextLevel()).toBe(false)
  })

  it('ends the run exactly once when congestion reaches the limit', () => {
    const { s, events } = session()
    s.start()
    ticks(s, 15)
    s.setCongestionForTesting(100)
    s.tick(DT)
    expect(s.state).toBe('gameOver')
    ticks(s, 10)
    s.update(10)
    const overs = events.filter((e) => e.type === 'gameOver')
    expect(overs).toHaveLength(1)
    expect(overs[0]).toMatchObject({ level: 1 })
    expect(s.pause()).toBe(false)
    expect(s.resume()).toBe(false)
    expect(s.nextLevel()).toBe(false)
  })

  it('loses a level eventually when traffic is never relieved', () => {
    const { s, events } = session({ seed: 1 })
    s.start()
    let level = 1
    while (s.state !== 'gameOver' && level < 10) {
      ticks(s, s.balance.levelDurationSec + 1)
      if (s.state === 'levelComplete') {
        s.nextLevel()
        level++
      }
    }
    expect(s.state).toBe('gameOver')
    expect(level).toBeGreaterThan(1) // level 1 is survivable without building
    expect(events.filter((e) => e.type === 'gameOver')).toHaveLength(1)
  })

  it('retries the failed level without losing completed-run progress', () => {
    const { s } = session({ seed: 42, balance: { levelDurationSec: 30 } })
    s.start()
    for (let i = 0; i < 30 / DT && s.state === 'running'; i++) {
      s.tick(DT)
      s.setCongestionForTesting(0)
    }
    expect(s.state).toBe('levelComplete')
    expect(s.nextLevel()).toBe(true)
    expect(s.level).toBe(2)

    const failedLevelSeed = s.world.seed
    const progress = s.snapshot()
    s.setCongestionForTesting(100)
    s.tick(DT)
    expect(s.state).toBe('gameOver')

    expect(s.restart()).toBe(true)
    expect(s.snapshot()).toMatchObject({
      state: 'running',
      level: 2,
      levelTime: 0,
      totalTime: progress.totalTime,
      congestion: 0,
      vehiclesExited: progress.vehiclesExited,
      score: progress.score,
      coins: progress.coins,
    })
    expect(s.world.seed).toBe(failedLevelSeed)
    expect(s.sim.stats().totalSpawned).toBe(0)
    expect(s.snapshot().activeVehicles).toBe(0)
  })

  it('is deterministic for a seed', () => {
    const play = () => {
      const s = new GameSession({ seed: 'snookjam' })
      s.start()
      ticks(s, 60)
      return s.snapshot()
    }
    expect(play()).toEqual(play())
  })


  it('round-trips a paused game and resumes deterministic traffic', () => {
    const original = new GameSession({ seed: 42 })
    original.start()
    ticks(original, 8)
    original.pause()
    const saved = JSON.parse(JSON.stringify(original.toSaveData()))
    const restored = GameSession.fromSaveData(saved)
    expect(restored.state).toBe('paused')
    expect(restored.toSaveData()).toEqual(saved)

    original.resume()
    restored.resume()
    ticks(original, 5)
    ticks(restored, 5)
    expect(restored.snapshot()).toEqual(original.snapshot())
    expect(restored.graph.toState()).toEqual(original.graph.toState())
    expect(restored.sim.toState()).toEqual(original.sim.toState())
    expect(restored.diagnostics.toState()).toEqual(original.diagnostics.toState())
  })

  it('rejects unsupported save versions and corrupt graph data', () => {
    const game = new GameSession({ seed: 42 })
    game.start()
    game.pause()
    const saved = JSON.parse(JSON.stringify(game.toSaveData()))
    expect(() => GameSession.fromSaveData({ ...saved, version: 99 })).toThrow(/unsupported save version/)
    const corrupt = { ...saved, graph: { ...saved.graph, edges: [{ ...saved.graph.edges[0], a: 999999 }] } }
    expect(() => GameSession.fromSaveData(corrupt)).toThrow()
  })

  it('builds roads through the session and keeps vehicles in place', () => {
    const { s } = session()
    expect(() => s.connectRoad({ kind: 'node', node: 0 }, { kind: 'node', node: 1 })).toThrow(/ready/)
    s.start()
    ticks(s, 5)
    const graph = s.graph
    const edge = graph.edges().find((e) => e.length >= 4)!
    const other = graph.edges().find((e) => e.id !== edge.id && e.a !== edge.a && e.a !== edge.b && e.b !== edge.a && e.b !== edge.b)!
    const positions = new Map(s.sim.vehicles().map((v) => [v.id, s.sim.positionOf(v).position]))
    const version = graph.version
    const result = s.connectRoad({ kind: 'edge', edge: edge.id, t: 0.5 }, { kind: 'edge', edge: other.id, t: 0.5 })
    expect(graph.version).toBeGreaterThan(version)
    expect(graph.getEdge(result.edge)).toBeDefined()
    for (const v of s.sim.vehicles()) {
      const before = positions.get(v.id)!
      const after = s.sim.positionOf(v).position
      expect(after.x).toBeCloseTo(before.x)
      expect(after.y).toBeCloseTo(before.y)
    }
    ticks(s, 5)
  })

  it('builds freehand roads through the session via bend points (#18)', () => {
    const { s } = session()
    s.start()
    ticks(s, 5)
    const edge = s.graph.edges().find((e) => e.length >= 4)!
    const from = { kind: 'edge', edge: edge.id, t: 0.25 } as const
    const to = { kind: 'edge', edge: edge.id, t: 0.75 } as const
    const p = s.graph.positionOf(from)
    const q = s.graph.positionOf(to)
    // A detour bulging out sideways from the edge, back onto the same edge.
    const nx = -(q.y - p.y) / Math.hypot(q.x - p.x, q.y - p.y)
    const ny = (q.x - p.x) / Math.hypot(q.x - p.x, q.y - p.y)
    const via = [{ x: (p.x + q.x) / 2 + nx * 2, y: (p.y + q.y) / 2 + ny * 2 }]
    const positions = new Map(s.sim.vehicles().map((v) => [v.id, s.sim.positionOf(v).position]))
    // Both ends on one edge: the second split retires a half of the first.
    const result = s.connectRoad(from, to, undefined, via)
    expect(result.splits).toHaveLength(2)
    expect(result.splits[1]!.removed).toBe(result.splits[0]!.towardB)
    expect(result.edges).toHaveLength(2)
    expect(s.graph.getNode(result.nodes[1]!)!.position).toEqual(via[0])
    for (const v of s.sim.vehicles()) {
      expect(s.graph.getEdge(v.steps[v.stepIndex]!.edge)).toBeDefined()
      const before = positions.get(v.id)!
      const after = s.sim.positionOf(v).position
      expect(after.x).toBeCloseTo(before.x)
      expect(after.y).toBeCloseTo(before.y)
    }
    ticks(s, 10)
  })

  it('commits construction-controller roads through the session', () => {
    const { s } = session()
    s.start()
    ticks(s, 5)
    const controller = new ConstructionController(s.world, s.graph, undefined, (a, b, via) => b.kind === 'point' ? s.connectRoadToPoint(a, b.position, undefined, via) : s.connectRoad(a, b, undefined, via))
    // Mid-edge to mid-edge, picking a pair the construction rules accept
    // (two-lane spacing and join angles, #22).
    const mids = s.graph.edges().filter((e) => e.length >= 4).map((e) => s.graph.positionOf({ kind: 'edge', edge: e.id, t: 0.5 }))
    const pair = mids.flatMap((a) => mids.map((b) => [a, b] as const)).find(([a, b]) => checkConnection(s.world, s.graph, a, b).ok)!
    expect(pair).toBeDefined()
    const [from, to] = pair
    controller.pointerDown(from)
    controller.pointerMove(to)
    const outcome = controller.pointerUp(to)
    expect(outcome.kind).toBe('committed')
    // Every vehicle still references live edges and keeps moving.
    for (const v of s.sim.vehicles()) expect(s.graph.getEdge(v.steps[v.stepIndex]!.edge)).toBeDefined()
    ticks(s, 10)
  })

  it('unsubscribes listeners', () => {
    const { s, events } = session()
    const seen: SessionEvent[] = []
    const off = s.subscribe((e) => seen.push(e))
    off()
    s.start()
    expect(seen).toEqual([])
    expect(events).toHaveLength(1)
  })
})
