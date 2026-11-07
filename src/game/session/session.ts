/**
 * Game lifecycle (#7): one run of Snookjam, from start screen to game over.
 *
 * States and transitions (anything else is rejected and returns false):
 *
 *   ready ──start──▶ running ◀──resume── paused
 *                    │  └──pause──▶ paused
 *                    ├─ survived levelDuration ─▶ levelComplete ──nextLevel──▶ running (level + 1)
 *                    └─ congestion reached limit ─▶ gameOver
 *   restart: from any state ─▶ running at the current level with a fresh world, sim and clock
 *
 * Each level gets its own seeded world (level 1 uses the run seed, later
 * levels derive from it), a fresh traffic sim and zero congestion. Time only
 * advances through update()/tick() while running, so pausing freezes
 * movement, spawning and congestion. The session is framework-independent;
 * Vue components read snapshot() and call the transition methods.
 */
import { DEFAULT_CONFIG } from '../config'
import { RoadGraph, type ConnectResult, type EdgeOptions, type NodeId, type Point, type RoadGraphState, type RoadLocation } from '../roads'
import { FixedStepClock, TrafficSim, type SignalOptions, type TrafficSimState } from '../sim'
import { createRng, createRoadGraph, generateWorld, mixSeed, normalizeSeed, type World, type WorldOptions } from '../world'
import { createBalance, maxVehiclesFor, spawnIntervalAt, startingVehiclesFor, vehicleMixFor, type BalanceConfig } from './balance'
import { NetworkMonitor, type NetworkMonitorState, type NetworkStats } from '../diagnostics'
import { congestionLevel, nextCongestion, type CongestionLevel } from './congestion'
import {
  createEconomy,
  EMPTY_INVENTORY,
  exitReward,
  levelReward,
  priceOf,
  type EconomyConfig,
  type Inventory,
  type Reward,
  type ShopItemId,
} from './economy'
import { RoadEditor, type EditResult, type PlayerRoad, type RoadEditorState } from './roadEditor'
import { evaluateObjectives, levelScore, objectivesFor, type GameMode, type ObjectiveDef, type ObjectiveProgress } from './objectives'

export type SessionState = 'ready' | 'running' | 'paused' | 'levelComplete' | 'gameOver'

/** Versioned, client-side save data. Transient rendering state is deliberately excluded. */
export interface GameSaveData {
  readonly format: 'snookjam-save'
  readonly version: 1
  readonly seed: number
  readonly mode: GameMode
  readonly worldOptions: Partial<WorldOptions>
  readonly balance: BalanceConfig
  readonly economy: EconomyConfig
  readonly objectives?: readonly (readonly ObjectiveDef[])[]
  readonly state: 'running' | 'paused'
  readonly level: number
  readonly world: World
  readonly graph: RoadGraphState
  readonly traffic: TrafficSimState
  readonly diagnostics: NetworkMonitorState
  readonly editor: RoadEditorState
  readonly congestion: number
  readonly levelTime: number
  readonly completedTime: number
  readonly exitedInRun: number
  readonly completedScore: number
  readonly coins: number
  readonly owned: Record<ShopItemId, number>
  readonly onMap: Record<ShopItemId, number>
}

export type SessionEvent =
  | { readonly type: 'stateChange'; readonly from: SessionState; readonly to: SessionState }
  | { readonly type: 'levelComplete'; readonly level: number; readonly reward: Reward }
  | {
      readonly type: 'gameOver'
      readonly level: number
      readonly levelTime: number
      readonly totalTime: number
      readonly reason: EndReason
    }

/** Why a run ended: gridlock, or objectives missed when the timer ran out (#35). */
export type EndReason = 'congestion' | 'objectives'

export interface SessionOptions {
  readonly seed: number | string
  readonly balance?: Partial<BalanceConfig>
  readonly world?: Partial<WorldOptions>
  /** Coin and shop tuning. */
  readonly economy?: Partial<EconomyConfig>
  /** Fixed simulation rate; defaults to the game config (20 Hz). */
  readonly simulationHz?: number
  /** Game mode (#35); defaults to 'classic'. */
  readonly mode?: GameMode
  /** Objectives per level for 'objectives' mode; defaults to LEVEL_OBJECTIVES. */
  readonly objectives?: readonly (readonly ObjectiveDef[])[]
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
  /** Desired active fleet size for the current level. */
  readonly activeVehicleTarget: number
  readonly pendingVehicles: number
  readonly vehiclesExited: number
  /** Traffic diagnostics for the current level (#34). */
  readonly network: NetworkStats
  readonly mode: GameMode
  /** Objectives of the current level with live progress (empty outside 'objectives' mode). */
  readonly objectives: readonly ObjectiveProgress[]
  /** Points earned this level so far. */
  readonly levelScore: number
  /** Points across the run, including this level. */
  readonly score: number
  /** Set once the run has ended. */
  readonly endReason: EndReason | undefined
  /** Coins available to spend in the shop. */
  readonly coins: number
  /** Shop items owned but not placed. */
  readonly inventory: Inventory
  /** Shop items currently placed on this level's map. */
  readonly placed: Inventory
  /** Coins paid for the last completed level, while its overlay shows. */
  readonly levelReward: Reward | undefined
}

interface Level {
  readonly world: World
  readonly graph: RoadGraph
  readonly sim: TrafficSim
  readonly editor: RoadEditor
  readonly diagnostics: NetworkMonitor
}

export class GameSession {
  readonly balance: BalanceConfig
  readonly economy: EconomyConfig
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
  readonly mode: GameMode
  private readonly objectiveTable: readonly (readonly ObjectiveDef[])[] | undefined
  /** Score of the levels already completed this run. */
  private completedScore = 0
  /** Objective results frozen when the level timer ran out. */
  private finalObjectives: ObjectiveProgress[] | undefined
  private endReason: EndReason | undefined
  private coinsValue = 0
  private owned: Record<ShopItemId, number> = { ...EMPTY_INVENTORY }
  private onMap: Record<ShopItemId, number> = { ...EMPTY_INVENTORY }
  private lastReward: Reward | undefined

  constructor(options: SessionOptions) {
    this.balance = createBalance(options.balance)
    this.economy = createEconomy(options.economy)
    this.coinsValue = this.economy.startingCoins
    this.seed = normalizeSeed(options.seed)
    this.worldOptions = {
      width: DEFAULT_CONFIG.mapWidth,
      height: DEFAULT_CONFIG.mapHeight,
      ...options.world,
    }
    this.mode = options.mode ?? 'classic'
    this.objectiveTable = options.objectives
    this.clock = new FixedStepClock(options.simulationHz ?? DEFAULT_CONFIG.simulationHz)
    this.current = this.buildLevel(1)
  }


  /** Exports a complete deterministic save of the current active level. */
  toSaveData(): GameSaveData {
    if (this.stateValue !== 'running' && this.stateValue !== 'paused') {
      throw new Error('only an active game can be saved')
    }
    return {
      format: 'snookjam-save',
      version: 1,
      seed: this.seed,
      mode: this.mode,
      worldOptions: { ...this.worldOptions },
      balance: this.balance,
      economy: this.economy,
      ...(this.objectiveTable === undefined ? {} : { objectives: this.objectiveTable }),
      state: this.stateValue,
      level: this.levelNumber,
      world: this.current.world,
      graph: this.current.graph.toState(),
      traffic: this.current.sim.toState(),
      diagnostics: this.current.diagnostics.toState(),
      editor: this.current.editor.toState(),
      congestion: this.congestionValue,
      levelTime: this.levelTime,
      completedTime: this.completedTime,
      exitedInRun: this.exitedInRun,
      completedScore: this.completedScore,
      coins: this.coinsValue,
      owned: { ...this.owned },
      onMap: { ...this.onMap },
    }
  }

  /** Validates and restores a save. The returned game is paused until resumed by the player. */
  static fromSaveData(input: unknown): GameSession {
    if (!input || typeof input !== 'object') throw new TypeError('save data must be an object')
    const data = input as GameSaveData
    const finite = (n: number) => Number.isFinite(n) && n >= 0
    if (data.format !== 'snookjam-save' || data.version !== 1) throw new Error('unsupported save version')
    if (!Number.isInteger(data.seed) || !Number.isInteger(data.level) || data.level < 1 ||
      !['classic', 'objectives', 'sandbox'].includes(data.mode) ||
      !['running', 'paused'].includes(data.state) ||
      !data.world || !Number.isInteger(data.world.width) || !Number.isInteger(data.world.height) ||
      data.world.width < 12 || data.world.height < 12 ||
      !Array.isArray(data.world.terrain) || data.world.terrain.length !== data.world.width * data.world.height ||
      !Array.isArray(data.world.road) || data.world.road.length !== data.world.width * data.world.height ||
      !Array.isArray(data.world.portals) || data.world.portals.length < 2 ||
      !finite(data.congestion) || data.congestion > 100 || !finite(data.levelTime) ||
      !finite(data.completedTime) || !finite(data.exitedInRun) || !finite(data.completedScore) ||
      !finite(data.coins) || !data.owned || !data.onMap) throw new TypeError('invalid save data')
    const world = data.world
    const graph = RoadGraph.fromState(data.graph)
    for (const portal of world.portals) if (!graph.hasNode(portal.nodeId)) throw new TypeError('saved portal is missing from road graph')
    const session = new GameSession({
      seed: data.seed,
      mode: data.mode,
      balance: data.balance,
      economy: data.economy,
      world: data.worldOptions,
      objectives: data.objectives,
    })
    const sim = new TrafficSim(graph, {
      portals: world.portals.map((portal) => portal.nodeId),
      random: createRng(mixSeed(world.seed, 0x7a11)),
      startingVehicles: startingVehiclesFor(session.balance, data.level),
      maxVehicles: maxVehiclesFor(session.balance, data.level),
      spawnIntervalSec: spawnIntervalAt(session.balance, data.level, 0),
      minSpawnIntervalSec: session.balance.minSpawnIntervalSec,
      junctionClearSec: session.balance.junctionClearSec,
      roundaboutClearFactor: session.balance.roundaboutClearFactor,
      signalClearFactor: session.balance.signalClearFactor,
      vehicleMix: vehicleMixFor(session.balance, data.level),
    })
    sim.restoreState(data.traffic)
    const diagnostics = new NetworkMonitor(graph, sim, { blockedAfterSec: session.balance.blockedAfterSec })
    diagnostics.restoreState(data.diagnostics)
    const editor = new RoadEditor(graph, sim, {
      connected: (result) => {
        for (const split of result.splits) {
          sim.applySplit(split)
          diagnostics.applySplit(split)
        }
      },
      removed: (result) => {
        sim.applyRemoval(result)
        diagnostics.applyRemoval(result)
      },
    })
    editor.restoreState(data.editor)
    session.current = { world, graph, sim, diagnostics, editor }
    session.levelNumber = data.level
    session.congestionValue = data.congestion
    session.levelTime = data.levelTime
    session.completedTime = data.completedTime
    session.exitedInRun = data.exitedInRun
    session.completedScore = data.completedScore
    session.coinsValue = data.coins
    session.owned = { ...data.owned }
    session.onMap = { ...data.onMap }
    session.stateValue = 'paused'
    session.clock.reset()
    return session
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

  /** Read-only traffic diagnostics for the current level (#34). */
  get diagnostics(): NetworkMonitor {
    return this.current.diagnostics
  }

  get congestion(): number {
    return this.congestionValue
  }

  get coins(): number {
    return this.coinsValue
  }

  /** Owned, unplaced count of a shop item. */
  owns(item: ShopItemId): number {
    return this.owned[item]
  }

  canAfford(item: ShopItemId): boolean {
    return this.coinsValue >= priceOf(this.economy, item)
  }

  /**
   * Buys one shop item into the inventory. Allowed whenever the run is not
   * over (including between levels). Returns false if coins are short.
   */
  buy(item: ShopItemId): boolean {
    if (this.stateValue === 'gameOver' || this.stateValue === 'ready') return false
    const price = priceOf(this.economy, item)
    if (this.coinsValue < price) return false
    this.coinsValue -= price
    this.owned[item]++
    return true
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
      activeVehicleTarget: maxVehiclesFor(this.balance, this.levelNumber),
      pendingVehicles: stats.pendingSpawns,
      vehiclesExited: this.exitedInRun,
      network: this.current.diagnostics.stats(),
      mode: this.mode,
      objectives: this.objectiveProgress(),
      levelScore: this.currentLevelScore(),
      score: this.completedScore + this.currentLevelScore(),
      endReason: this.endReason,
      coins: this.coinsValue,
      inventory: { ...this.owned },
      placed: { ...this.onMap },
      levelReward: this.stateValue === 'levelComplete' ? this.lastReward : undefined,
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

  /**
   * Retries the current level with its original seed and difficulty.
   * Completed-level time, score, exits and shop rewards remain part of the run.
   * Placed items return to inventory when loadLevel() resets the map.
   */
  restart(): boolean {
    this.endReason = undefined
    this.lastReward = undefined
    this.loadLevel(this.levelNumber)
    this.transition('running')
    return true
  }

  nextLevel(): boolean {
    if (this.stateValue !== 'levelComplete') return false
    this.completedTime += this.levelTime
    this.completedScore += this.currentLevelScore()
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
    const sandbox = this.mode === 'sandbox'
    if (!sandbox && this.congestionValue >= this.balance.congestionLimit) return this.endRun('congestion')
    const sim = this.current.sim
    sim.setSpawnInterval(spawnIntervalAt(this.balance, this.levelNumber, this.levelTime))
    const report = sim.step(dt)
    this.current.diagnostics.observe(dt)
    // Closing roads (#33) disappear once the last vehicle has left them.
    this.current.editor.update()
    this.levelTime += dt
    this.exitedInRun += report.exited
    if (report.exited > 0) this.earn(exitReward(this.economy, report.exited))

    let blocked = 0
    for (const v of sim.vehicles()) if (v.waitingFor >= this.balance.blockedAfterSec) blocked++
    const stats = sim.stats()
    this.congestionValue = nextCongestion(
      this.congestionValue,
      { active: stats.active, blocked, pending: stats.pendingSpawns, exited: report.exited, levelTime: this.levelTime },
      this.balance,
      dt,
    )

    if (sandbox) return // no timer and no gridlock loss
    if (this.congestionValue >= this.balance.congestionLimit) {
      this.endRun('congestion')
    } else if (this.levelTime >= this.balance.levelDurationSec - 1e-9) {
      const results = evaluateObjectives(this.levelObjectives(), this.current.diagnostics.stats(), true)
      this.finalObjectives = results
      if (results.every((o) => o.status === 'met')) {
        const reward = levelReward(this.economy, this.levelNumber, this.congestionValue, this.balance.congestionLimit, results.length)
        this.earn(reward)
        this.lastReward = reward
        this.transition('levelComplete')
        this.emit({ type: 'levelComplete', level: this.levelNumber, reward })
      } else {
        this.endRun('objectives')
      }
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
    return this.current.editor.build(from, to, via, options)
  }

  /** Adds a road ending on open terrain and migrates traffic on a split start edge. */
  connectRoadToPoint(from: RoadLocation, point: Point, options?: EdgeOptions, via: readonly Point[] = []): ConnectResult {
    if (this.stateValue !== 'running' && this.stateValue !== 'paused') {
      throw new Error(`cannot build roads while ${this.stateValue}`)
    }
    return this.current.editor.build(from, point, via, options)
  }

  /** Player-built roads on the map, open or closing (#33). */
  roads(): readonly PlayerRoad[] {
    return this.current.editor.roads()
  }

  /** Changes whenever the drawn player roads change. */
  get roadsVersion(): number {
    return this.current.editor.version
  }

  /** The player road nearest to `point`, within `maxDistance` tiles. */
  roadAt(point: Point, maxDistance: number): PlayerRoad | undefined {
    return this.current.editor.roadAt(point, maxDistance)
  }

  /** Whether vehicles are driving on a player road (removing it would close it first). */
  isRoadOccupied(id: number): boolean {
    return this.current.editor.isOccupied(id)
  }

  /**
   * Removes a player road (#33). An empty road goes at once; a road with
   * vehicles on it closes (no new traffic) and goes once they have left.
   */
  removeRoad(id: number): EditResult {
    this.requireBuildable('remove roads')
    return this.current.editor.remove(id)
  }

  get canUndo(): boolean {
    return this.current.editor.canUndo
  }

  get canRedo(): boolean {
    return this.current.editor.canRedo
  }

  /** Undoes the last road build or removal in this level. */
  undo(): EditResult {
    this.requireBuildable('undo')
    return this.current.editor.undo()
  }

  redo(): EditResult {
    this.requireBuildable('redo')
    return this.current.editor.redo()
  }

  /**
   * Applies a connection that was already committed to `session.graph`
   * elsewhere (e.g. by ConstructionController, #6), migrating vehicles on
   * split edges so nobody teleports.
   */
  applyConnection(result: ConnectResult): void {
    for (const split of result.splits) {
      this.current.sim.applySplit(split)
      this.current.diagnostics.applySplit(split)
    }
  }

  /**
   * Places a traffic signal on the junction containing `node` (#32), or
   * reconfigures the one there. Returns false if that junction cannot take
   * signals. Like building, only allowed while running or paused.
   */
  placeSignal(node: NodeId, options?: SignalOptions): boolean {
    this.requireBuildable('place signals')
    const sim = this.current.sim
    // Re-timing lights already there is free; new lights use one from the inventory.
    if (sim.signalAt(node)) return sim.placeSignal(node, options)
    if (this.owned.signal <= 0) return false
    if (!sim.placeSignal(node, options)) return false
    this.owned.signal--
    this.onMap.signal++
    return true
  }

  /** Removes the signal on the junction containing `node` back into the inventory. Returns whether there was one. */
  removeSignal(node: NodeId): boolean {
    this.requireBuildable('remove signals')
    if (!this.current.sim.removeSignal(node)) return false
    this.owned.signal++
    this.onMap.signal = Math.max(0, this.onMap.signal - 1)
    return true
  }

  /**
   * Builds a roundabout from the inventory on the junction containing
   * `node`. Returns false without one in stock, if the junction cannot take
   * one, has lights, or already has a roundabout.
   */
  placeRoundabout(node: NodeId): boolean {
    this.requireBuildable('build roundabouts')
    const sim = this.current.sim
    if (this.owned.roundabout <= 0 || sim.roundaboutAt(node)) return false
    if (!sim.placeRoundabout(node)) return false
    this.owned.roundabout--
    this.onMap.roundabout++
    return true
  }

  /** Removes the roundabout on the junction containing `node` back into the inventory. */
  removeRoundabout(node: NodeId): boolean {
    this.requireBuildable('remove roundabouts')
    if (!this.current.sim.removeRoundabout(node)) return false
    this.owned.roundabout++
    this.onMap.roundabout = Math.max(0, this.onMap.roundabout - 1)
    return true
  }

  /** Test hook: adds coins. */
  grantCoinsForTesting(coins: number): void {
    this.coinsValue += coins
  }

  private earn(reward: Reward): void {
    this.coinsValue += reward.coins
  }

  private requireBuildable(action: string): void {
    if (this.stateValue !== 'running' && this.stateValue !== 'paused') {
      throw new Error(`cannot ${action} while ${this.stateValue}`)
    }
  }

  /** Test hook: sets congestion directly (clamped). */
  setCongestionForTesting(value: number): void {
    this.congestionValue = Math.min(this.balance.congestionLimit, Math.max(0, value))
  }

  /** Objectives of the current level (empty outside 'objectives' mode). */
  levelObjectives(): readonly ObjectiveDef[] {
    return objectivesFor(this.mode, this.levelNumber, this.objectiveTable)
  }

  private objectiveProgress(): readonly ObjectiveProgress[] {
    return this.finalObjectives ?? evaluateObjectives(this.levelObjectives(), this.current.diagnostics.stats(), false)
  }

  /** Journeys so far plus objectives met once the level has been judged. */
  private currentLevelScore(): number {
    const met = this.finalObjectives?.filter((o) => o.status === 'met').length ?? 0
    return levelScore(this.current.diagnostics.stats().completedJourneys, met)
  }

  private endRun(reason: EndReason): void {
    this.endReason = reason
    this.transition('gameOver')
    this.emit({
      type: 'gameOver',
      level: this.levelNumber,
      levelTime: this.levelTime,
      totalTime: this.completedTime + this.levelTime,
      reason,
    })
  }

  private loadLevel(level: number): void {
    // A new map: whatever was placed on the old one goes back into stock.
    for (const item of Object.keys(this.onMap) as ShopItemId[]) {
      this.owned[item] += this.onMap[item]
      this.onMap[item] = 0
    }
    this.current = this.buildLevel(level)
    this.congestionValue = 0
    this.levelTime = 0
    this.finalObjectives = undefined
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
      maxVehicles: maxVehiclesFor(this.balance, level),
      spawnIntervalSec: spawnIntervalAt(this.balance, level, 0),
      minSpawnIntervalSec: this.balance.minSpawnIntervalSec,
      junctionClearSec: this.balance.junctionClearSec,
      roundaboutClearFactor: this.balance.roundaboutClearFactor,
      signalClearFactor: this.balance.signalClearFactor,
      vehicleMix: vehicleMixFor(this.balance, level),
    })
    const diagnostics = new NetworkMonitor(graph, sim, { blockedAfterSec: this.balance.blockedAfterSec })
    const editor = new RoadEditor(graph, sim, {
      connected: (result) => {
        for (const split of result.splits) {
          sim.applySplit(split)
          diagnostics.applySplit(split)
        }
      },
      removed: (result) => {
        sim.applyRemoval(result)
        diagnostics.applyRemoval(result)
      },
    })
    return { world, graph, sim, diagnostics, editor }
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
