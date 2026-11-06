/**
 * Game lifecycle (#7): one run of Snookjam, from start screen to game over.
 *
 * States and transitions (anything else is rejected and returns false):
 *
 *   ready ──start──▶ running ◀──resume── paused
 *                    │  └──pause──▶ paused
 *                    ├─ survived levelDuration ─▶ levelComplete ──nextLevel──▶ running (level + 1)
 *                    └─ congestion reached limit ─▶ gameOver
 *   restart: from any state ─▶ running at level 1 with a fresh world, sim and clock
 *
 * Each level gets its own seeded world (level 1 uses the run seed, later
 * levels derive from it), a fresh traffic sim and zero congestion. Time only
 * advances through update()/tick() while running, so pausing freezes
 * movement, spawning and congestion. The session is framework-independent;
 * Vue components read snapshot() and call the transition methods.
 */
import { DEFAULT_CONFIG } from '../config'
import type { ConnectResult, EdgeOptions, Point, RoadGraph, RoadLocation } from '../roads'
import { FixedStepClock, TrafficSim } from '../sim'
import { createRng, createRoadGraph, generateWorld, mixSeed, normalizeSeed, type World, type WorldOptions } from '../world'
import { createBalance, spawnIntervalAt, startingVehiclesFor, vehicleMixFor, type BalanceConfig } from './balance'
import { congestionLevel, nextCongestion, type CongestionLevel } from './congestion'

export type SessionState = 'ready' | 'running' | 'paused' | 'levelComplete' | 'gameOver'

export type SessionEvent =
  | { readonly type: 'stateChange'; readonly from: SessionState; readonly to: SessionState }
  | { readonly type: 'levelComplete'; readonly level: number }
  | { readonly type: 'gameOver'; readonly level: number; readonly levelTime: number; readonly totalTime: number }

export interface SessionOptions {
  readonly seed: number | string
  readonly balance?: Partial<BalanceConfig>
  readonly world?: Partial<WorldOptions>
  /** Fixed simulation rate; defaults to the game config (20 Hz). */
  readonly simulationHz?: number
}

/** Read-only view of the session for the HUD (#8). */
export interface SessionSnapshot {
  readonly state: SessionState
  readonly level: number
  readonly seed: number
  /** Seconds survived in the current level. */
  readonly levelTime: number
  readonly levelDuration: number
  readonly timeRemaining: number
  /** Seconds survived across all levels in this run. */
  readonly totalTime: number
  /** 0–100. */
  readonly congestion: number
  readonly congestionLevel: CongestionLevel
  readonly activeVehicles: number
  readonly pendingVehicles: number
  readonly vehiclesExited: number
}

interface Level {
  readonly world: World
  readonly graph: RoadGraph
  readonly sim: TrafficSim
}

export class GameSession {
  readonly balance: BalanceConfig
  readonly seed: number
  private readonly worldOptions: Partial<WorldOptions>
  private readonly clock: FixedStepClock
  private readonly listeners = new Set<(event: SessionEvent) => void>()

  private stateValue: SessionState = 'ready'
  private levelNumber = 1
  private current: Level
  private congestionValue = 0
  private levelTime = 0
  private completedTime = 0
  private exitedInRun = 0

  constructor(options: SessionOptions) {
    this.balance = createBalance(options.balance)
    this.seed = normalizeSeed(options.seed)
    this.worldOptions = {
      width: DEFAULT_CONFIG.mapWidth,
      height: DEFAULT_CONFIG.mapHeight,
      ...options.world,
    }
    this.clock = new FixedStepClock(options.simulationHz ?? DEFAULT_CONFIG.simulationHz)
    this.current = this.buildLevel(1)
  }

  get state(): SessionState {
    return this.stateValue
  }

  get level(): number {
    return this.levelNumber
  }

  get world(): World {
    return this.current.world
  }

  get graph(): RoadGraph {
    return this.current.graph
  }

  get sim(): TrafficSim {
    return this.current.sim
  }

  get congestion(): number {
    return this.congestionValue
  }

  /** Subscribes to lifecycle events; returns an unsubscribe function. */
  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): SessionSnapshot {
    const stats = this.current.sim.stats()
    const duration = this.balance.levelDurationSec
    return {
      state: this.stateValue,
      level: this.levelNumber,
      seed: this.current.world.seed,
      levelTime: this.levelTime,
      levelDuration: duration,
      timeRemaining: Math.max(0, duration - this.levelTime),
      totalTime: this.completedTime + this.levelTime,
      congestion: this.congestionValue,
      congestionLevel: congestionLevel(this.congestionValue, this.balance),
      activeVehicles: stats.active,
      pendingVehicles: stats.pendingSpawns,
      vehiclesExited: this.exitedInRun,
    }
  }

  start(): boolean {
    if (this.stateValue !== 'ready') return false
    this.clock.reset()
    this.transition('running')
    return true
  }

  pause(): boolean {
    if (this.stateValue !== 'running') return false
    this.transition('paused')
    return true
  }

  resume(): boolean {
    if (this.stateValue !== 'paused') return false
    this.clock.reset() // do not catch up on time spent paused
    this.transition('running')
    return true
  }

  /** Starts a clean run at level 1 with the same seed. */
  restart(): boolean {
    this.levelNumber = 1
    this.completedTime = 0
    this.exitedInRun = 0
    this.loadLevel(1)
    this.transition('running')
    return true
  }

  nextLevel(): boolean {
    if (this.stateValue !== 'levelComplete') return false
    this.completedTime += this.levelTime
    this.levelNumber++
    this.loadLevel(this.levelNumber)
    this.transition('running')
    return true
  }

  /**
   * Advances by real elapsed time (e.g. from requestAnimationFrame) using
   * the fixed-step clock. Returns the number of simulation steps run.
   */
  update(elapsedSec: number): number {
    if (this.stateValue !== 'running') return 0
    const steps = this.clock.advance(elapsedSec)
    let ran = 0
    while (ran < steps && this.stateValue === 'running') {
      this.tick(this.clock.stepSec)
      ran++
    }
    return ran
  }

  /** Runs exactly one fixed step of `dt` seconds (for tests and tools). */
  tick(dt = this.clock.stepSec): void {
    if (this.stateValue !== 'running') return
    if (this.congestionValue >= this.balance.congestionLimit) return this.endRun()
    const sim = this.current.sim
    sim.setSpawnInterval(spawnIntervalAt(this.balance, this.levelNumber, this.levelTime))
    const report = sim.step(dt)
    this.levelTime += dt
    this.exitedInRun += report.exited

    let blocked = 0
    for (const v of sim.vehicles()) if (v.waitingFor >= this.balance.blockedAfterSec) blocked++
    const stats = sim.stats()
    this.congestionValue = nextCongestion(
      this.congestionValue,
      { active: stats.active, blocked, pending: stats.pendingSpawns, exited: report.exited, levelTime: this.levelTime },
      this.balance,
      dt,
    )

    if (this.congestionValue >= this.balance.congestionLimit) {
      this.endRun()
    } else if (this.levelTime >= this.balance.levelDurationSec - 1e-9) {
      this.transition('levelComplete')
      this.emit({ type: 'levelComplete', level: this.levelNumber })
    }
  }

  /**
   * Adds a player-built road and keeps vehicles on split edges in place.
   * Terrain/obstacle validation is the caller's responsibility (#6); this
   * throws if the graph rejects the connection, leaving everything unchanged.
   */
  connectRoad(
    from: RoadLocation,
    to: RoadLocation,
    options?: EdgeOptions,
    via: readonly Point[] = [],
  ): ConnectResult {
    if (this.stateValue !== 'running' && this.stateValue !== 'paused') {
      throw new Error(`cannot build roads while ${this.stateValue}`)
    }
    const result = this.current.graph.connect(from, to, options, via)
    this.applyConnection(result)
    return result
  }

  /** Adds a road ending on open terrain and migrates traffic on a split start edge. */
  connectRoadToPoint(from: RoadLocation, point: Point, options?: EdgeOptions, via: readonly Point[] = []): ConnectResult {
    if (this.stateValue !== 'running' && this.stateValue !== 'paused') {
      throw new Error(`cannot build roads while ${this.stateValue}`)
    }
    const result = this.current.graph.connectToPoint(from, point, options, via)
    this.applyConnection(result)
    return result
  }

  /**
   * Applies a connection that was already committed to `session.graph`
   * elsewhere (e.g. by ConstructionController, #6), migrating vehicles on
   * split edges so nobody teleports.
   */
  applyConnection(result: ConnectResult): void {
    for (const split of result.splits) this.current.sim.applySplit(split)
  }

  /** Test hook: sets congestion directly (clamped). */
  setCongestionForTesting(value: number): void {
    this.congestionValue = Math.min(this.balance.congestionLimit, Math.max(0, value))
  }

  private endRun(): void {
    this.transition('gameOver')
    this.emit({
      type: 'gameOver',
      level: this.levelNumber,
      levelTime: this.levelTime,
      totalTime: this.completedTime + this.levelTime,
    })
  }

  private loadLevel(level: number): void {
    this.current = this.buildLevel(level)
    this.congestionValue = 0
    this.levelTime = 0
    this.clock.reset()
  }

  private buildLevel(level: number): Level {
    const worldSeed = level === 1 ? this.seed : mixSeed(this.seed, level)
    const world = generateWorld(worldSeed, this.worldOptions)
    const graph = createRoadGraph(world)
    const sim = new TrafficSim(graph, {
      portals: world.portals.map((p) => p.nodeId),
      random: createRng(mixSeed(worldSeed, 0x7a11)),
      startingVehicles: startingVehiclesFor(this.balance, level),
      maxVehicles: this.balance.maxVehicles,
      spawnIntervalSec: spawnIntervalAt(this.balance, level, 0),
      minSpawnIntervalSec: this.balance.minSpawnIntervalSec,
      junctionClearSec: this.balance.junctionClearSec,
      vehicleMix: vehicleMixFor(this.balance, level),
    })
    return { world, graph, sim }
  }

  private transition(to: SessionState): void {
    const from = this.stateValue
    this.stateValue = to
    this.emit({ type: 'stateChange', from, to })
  }

  private emit(event: SessionEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}
