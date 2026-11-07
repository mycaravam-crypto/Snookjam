/**
 * Junction movements, right-of-way and traffic signals (#32).
 */
import { describe, expect, it } from 'vitest'
import { GameSession } from '@game/index'
import { RoadGraph, type RouteStep } from '../../../src/game/roads'
import {
  comesFromRight,
  defaultPhases,
  orderByRightOfWay,
  signalPhaseAt,
  SIGNAL_CLEARANCE_SEC,
  TrafficSim,
  type JunctionLane,
  type RandomSource,
} from '../../../src/game/sim'
import { collisions } from './footprint'

const DT = 1 / 20

function rng(seed: number): RandomSource {
  let state = seed >>> 0
  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

/** A four-way crossroads at node 4 with a tunnel at the end of each arm. */
function plus(): RoadGraph {
  return RoadGraph.fromLayout({
    nodes: [
      { id: 0, x: 8, y: 0 }, // north
      { id: 1, x: 16, y: 8 }, // east
      { id: 2, x: 8, y: 16 }, // south
      { id: 3, x: 0, y: 8 }, // west
      { id: 4, x: 8, y: 8 },
    ],
    segments: [
      { from: 0, to: 4 },
      { from: 1, to: 4 },
      { from: 2, to: 4 },
      { from: 3, to: 4 },
    ],
  })
}

const busyPlus = (seed = 1) =>
  new TrafficSim(plus(), { portals: [0, 1, 2, 3], random: rng(seed), startingVehicles: 8, spawnIntervalSec: 0.7, minSpawnIntervalSec: 0.7 })

describe('junction movements (#32)', () => {
  it('describes approaches, exits and movements of a crossroads', () => {
    const sim = busyPlus()
    const j = sim.junctionAt(4)!
    expect(j.nodes).toEqual([4])
    expect(j.center).toEqual({ x: 8, y: 8 })
    expect(j.approaches).toHaveLength(4)
    expect(j.exits).toHaveLength(4)
    // Every approach to every other road: no U-turns.
    expect(j.movements).toHaveLength(12)
    expect(j.movements.every((m) => m.approach.edge !== m.exit.edge)).toBe(true)
    // The approach from the west tunnel heads east (0 rad), from the south heads north.
    const west = j.approaches.find((a) => a.edge === 3)!
    const south = j.approaches.find((a) => a.edge === 2)!
    expect(west.heading).toBeCloseTo(0)
    expect(south.heading).toBeCloseTo(-Math.PI / 2)
    expect(sim.isSignalJunction(j)).toBe(true)
  })

  it('tunnels and plain bends are not signal junctions', () => {
    const sim = busyPlus()
    expect(sim.placeSignal(0)).toBe(false) // tunnel (dead end)
    const corridor = RoadGraph.fromLayout({
      nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 4, y: 0 }, { id: 2, x: 4, y: 4 }],
      segments: [{ from: 0, to: 1 }, { from: 1, to: 2 }],
    })
    const s2 = new TrafficSim(corridor, { portals: [0, 2], random: rng(1) })
    expect(s2.placeSignal(1)).toBe(false) // a right-angle bend is not a junction
  })
})

describe('uncontrolled right-of-way (#32)', () => {
  it('serves the vehicle that arrived first', () => {
    const order = orderByRightOfWay([
      { id: 1, arrivedAt: 2, heading: 0 },
      { id: 2, arrivedAt: 1, heading: Math.PI },
    ])
    expect(order.map((c) => c.id)).toEqual([2, 1])
  })

  it('on a tie, yields to traffic from the right', () => {
    // Heading east, a vehicle heading north comes from the right (y points down).
    expect(comesFromRight(0, -Math.PI / 2)).toBe(true)
    expect(comesFromRight(0, Math.PI / 2)).toBe(false)
    expect(comesFromRight(0, Math.PI)).toBe(false)
    const order = orderByRightOfWay([
      { id: 1, arrivedAt: 5, heading: 0 },
      { id: 2, arrivedAt: 5, heading: -Math.PI / 2 },
    ])
    expect(order.map((c) => c.id)).toEqual([2, 1])
  })

  it('breaks a four-way standoff deterministically by id', () => {
    const all = [0, Math.PI / 2, Math.PI, -Math.PI / 2].map((heading, i) => ({ id: 10 - i, arrivedAt: 3, heading }))
    expect(orderByRightOfWay(all).map((c) => c.id)).toEqual([7, 8, 9, 10])
    expect(orderByRightOfWay([...all].reverse()).map((c) => c.id)).toEqual([7, 8, 9, 10])
  })

  it('keeps a busy uncontrolled crossroads collision-free and flowing', () => {
    const sim = busyPlus(3)
    for (let i = 0; i < 20 * 90; i++) {
      sim.step(DT)
      if (i % 2 === 0) expect(collisions(sim)).toEqual([])
    }
    expect(sim.stats().totalExited).toBeGreaterThan(40)
  })
})

describe('signal timing (#32)', () => {
  const lanes = (headings: number[]): JunctionLane[] => headings.map((heading, i) => ({ edge: i, node: 0, position: { x: 0, y: 0 }, heading }))

  it('pairs opposite approaches into one phase', () => {
    expect(defaultPhases(lanes([0, -Math.PI / 2, Math.PI, Math.PI / 2]))).toEqual([[0, 2], [1, 3]])
    // A T-junction: the through road shares a phase, the side road has its own.
    expect(defaultPhases(lanes([0, Math.PI, -Math.PI / 2]))).toEqual([[0, 1], [2]])
  })

  it('cycles green, all-red clearance, next phase', () => {
    expect(signalPhaseAt(2, 10, 0)).toMatchObject({ phase: 0, clearance: false })
    expect(signalPhaseAt(2, 10, 10.5)).toMatchObject({ phase: 0, clearance: true })
    expect(signalPhaseAt(2, 10, 10 + SIGNAL_CLEARANCE_SEC + 0.01)).toMatchObject({ phase: 1, clearance: false })
    expect(signalPhaseAt(2, 10, 2 * (10 + SIGNAL_CLEARANCE_SEC) + 1)).toMatchObject({ phase: 0, clearance: false })
    expect(signalPhaseAt(2, 10, 3).remaining).toBeCloseTo(7)
  })
})

describe('traffic signals in the simulation (#32)', () => {
  it('can be placed, configured and removed', () => {
    const sim = busyPlus()
    expect(sim.signals()).toHaveLength(0)
    expect(sim.placeSignal(4, { greenSec: 5 })).toBe(true)
    const placed = sim.signalAt(4)!
    expect(placed).toMatchObject({ node: 4, greenSec: 5, phase: 0, clearance: false })
    expect(placed.lights).toHaveLength(4)
    expect(placed.lights.filter((l) => l === 'green')).toHaveLength(2)
    expect(sim.placeSignal(4, { greenSec: 15 })).toBe(true)
    expect(sim.signals()).toHaveLength(1)
    expect(sim.signalAt(4)!.greenSec).toBe(15)
    expect(sim.removeSignal(4)).toBe(true)
    expect(sim.removeSignal(4)).toBe(false)
    expect(sim.signals()).toHaveLength(0)
    expect(() => sim.placeSignal(4, { greenSec: 0 })).toThrow(RangeError)
  })

  it('finds the nearest signal junction to a point', () => {
    const sim = busyPlus()
    expect(sim.signalJunctionNear({ x: 8.6, y: 7.5 }, 1.5)?.key).toBe(4)
    expect(sim.signalJunctionNear({ x: 3, y: 3 }, 1.5)).toBeUndefined()
  })

  it('only admits green approaches, never during clearance, and never two vehicles at once', () => {
    const sim = busyPlus(2)
    sim.placeSignal(4, { greenSec: 5 })
    const approachOf = new Map<number, RouteStep>()
    let holder: number | undefined
    let admissions = 0
    let redWaits = 0
    for (let i = 0; i < 20 * 120; i++) {
      sim.step(DT)
      const view = sim.signalAt(4)!
      const next = sim.junctionHolderAt(4)
      if (next !== undefined && next !== holder) {
        // A new vehicle claimed the box this step: its approach must be green.
        const step = approachOf.get(next)!
        const index = view.junction.approaches.findIndex((a) => a.edge === step.edge && a.node === step.to)
        expect(view.lights[index], `vehicle ${next} at t=${i * DT}`).toBe('green')
        admissions++
      }
      holder = next
      for (const v of sim.vehicles()) {
        const step = v.steps[v.stepIndex]!
        if (step.to === 4) approachOf.set(v.id, step)
        const index = view.junction.approaches.findIndex((a) => a.edge === step.edge && a.node === step.to)
        if (index >= 0 && view.lights[index] === 'red' && v.state === 'waiting') redWaits++
      }
      if (i % 2 === 0) expect(collisions(sim)).toEqual([])
    }
    expect(admissions).toBeGreaterThan(30)
    // Queues form on red.
    expect(redWaits).toBeGreaterThan(100)
  })

  it('queues and congestion respond to the signal timing', () => {
    // A long green for the north-south road starves east-west traffic.
    const run = (greenSec: number | undefined) => {
      const sim = busyPlus(4)
      if (greenSec !== undefined) sim.placeSignal(4, { greenSec })
      let waiting = 0
      for (let i = 0; i < 20 * 90; i++) {
        sim.step(DT)
        waiting += sim.stats().waiting
      }
      return { waiting, exited: sim.stats().totalExited }
    }
    const none = run(undefined)
    const long = run(60)
    expect(long.waiting).toBeGreaterThan(none.waiting)
    expect(long.exited).toBeLessThan(none.exited)
  })

  it('holds a green approach whose exit is full instead of blocking the box', () => {
    // West tunnel -> junction 4 -> short road (capacity 1) -> junction 5 -> east tunnel.
    // Junction 5's signal keeps the east-west road red for a long time, so
    // the short road fills and junction 4 must keep its box clear.
    const graph = RoadGraph.fromLayout({
      nodes: [
        { id: 0, x: 0, y: 8 }, // west tunnel
        { id: 1, x: 20, y: 8 }, // east tunnel
        { id: 4, x: 8, y: 8 },
        { id: 5, x: 11, y: 8 },
        { id: 6, x: 11, y: 4 }, // stubs at 5 (listed first: phase 0)
        { id: 7, x: 11, y: 12 },
        { id: 8, x: 8, y: 4 }, // stubs at 4
        { id: 9, x: 8, y: 12 },
      ],
      segments: [
        { from: 6, to: 5 },
        { from: 7, to: 5 },
        { from: 0, to: 4 },
        { from: 4, to: 5, capacity: 1 },
        { from: 5, to: 1 },
        { from: 8, to: 4 },
        { from: 9, to: 4 },
      ],
    })
    const sim = new TrafficSim(graph, { portals: [0, 1], random: { next: () => 0 }, startingVehicles: 6, spawnIntervalSec: 1.5, minSpawnIntervalSec: 1.5 })
    expect(sim.placeSignal(5, { greenSec: 1000 })).toBe(true)
    const into5 = sim.signalAt(5)!.junction.approaches.findIndex((a) => a.node === 5 && graph.getEdge(a.edge)!.a === 4)
    expect(sim.signalAt(5)!.lights[into5]).toBe('red')
    let held = 0
    for (let i = 0; i < 20 * 60; i++) {
      sim.step(DT)
      // Junction 4 is uncontrolled: anyone holding its box must be able to leave it.
      const holder = sim.junctionHolderAt(4)
      if (holder !== undefined) {
        const v = sim.getVehicle(holder)!
        if (v.state === 'waiting' && v.steps[v.stepIndex]!.to === 4) held++
      }
      if (i % 2 === 0) expect(collisions(sim)).toEqual([])
    }
    // The short road is full and the queue waits before junction 4, not in it.
    expect(sim.laneOccupants(graph.edges().find((e) => e.a === 4 && e.b === 5)!.id, 4)).toHaveLength(1)
    expect(sim.junctionHolderAt(4)).toBeUndefined()
    expect(held).toBe(0)
    expect(sim.vehicles().filter((v) => v.state === 'waiting').length).toBeGreaterThan(2)
  })

  it('is deterministic with signals', () => {
    const run = () => {
      const sim = busyPlus(6)
      sim.placeSignal(4, { greenSec: 5 })
      for (let i = 0; i < 20 * 60; i++) sim.step(DT)
      return JSON.stringify(sim.vehicles())
    }
    expect(run()).toBe(run())
  })
})

describe('signals through the game session (#32)', () => {
  it('places and removes signals only while the level is playable', () => {
    const session = new GameSession({ seed: 9 })
    const junction = session.sim.junctions().find((j) => session.sim.isSignalJunction(j))!
    expect(() => session.placeSignal(junction.key)).toThrow(/ready/)
    session.start()
    expect(session.placeSignal(junction.key, { greenSec: 5 })).toBe(true)
    expect(session.sim.signals()).toHaveLength(1)
    session.pause()
    expect(session.removeSignal(junction.key)).toBe(true)
    expect(session.sim.signals()).toHaveLength(0)
  })
})
