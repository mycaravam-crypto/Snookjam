import { describe, expect, it, vi } from 'vitest'
import {
  clientToWorld,
  ConstructionController,
  createRoadGraph,
  findRoute,
  fitViewport,
  worldToScreen,
} from '@game/index'
import { asciiWorld, BOTTOM_LEFT, LOOP, TOP_LEFT } from './fixtures'

function setup() {
  const world = asciiWorld(LOOP)
  const graph = createRoadGraph(world)
  return { world, graph, controller: new ConstructionController(world, graph) }
}

describe('ConstructionController', () => {
  it('ignores pointer-down away from roads', () => {
    const { controller } = setup()
    expect(controller.pointerDown({ x: 3.5, y: 3.5 })).toBe(false)
    expect(controller.preview).toBeUndefined()
    expect(controller.pointerUp({ x: 3.5, y: 5.5 })).toEqual({ kind: 'none' })
  })

  it('starts a snapped preview on pointer-down and follows pointer-move', () => {
    const { controller } = setup()
    expect(controller.pointerDown({ x: 2.4, y: 1.8 })).toBe(true)
    expect(controller.preview?.from).toEqual({ x: 2.4, y: 1.5 })
    controller.pointerMove({ x: 2.4, y: 3.2 })
    expect(controller.preview?.check.ok).toBe(true)
    expect(controller.preview?.to).toEqual({ x: 2.4, y: 3.2 })
    controller.pointerMove({ x: 2.4, y: 5.3 })
    expect(controller.preview?.check.ok).toBe(true)
    expect(controller.preview?.to).toEqual({ x: 2.4, y: 5.5 })
  })

  it('allows a road to end on open terrain and extends that dead end later', () => {
    const { controller, graph } = setup()
    const initialNodes = graph.nodeCount
    controller.pointerDown({ x: 2.5, y: 1.5 })
    controller.pointerMove({ x: 3, y: 2.5 })
    const first = controller.pointerUp({ x: 3.5, y: 3.5 })
    expect(first.kind).toBe('committed')
    if (first.kind !== 'committed') return
    expect(first.road.to).toEqual({ x: 3.5, y: 3.5 })
    expect(graph.nodeCount).toBeGreaterThan(initialNodes)
    const deadEnd = first.road.to
    expect(controller.pointerDown(deadEnd)).toBe(true)
    const second = controller.pointerUp({ x: 4.2, y: 4.5 })
    expect(second.kind).toBe('committed')
  })

  it('commits exactly one connection on a valid pointer-up', () => {
    const { controller, graph } = setup()
    const edges = graph.edgeCount
    controller.pointerDown({ x: 2.5, y: 1.5 })
    controller.pointerMove({ x: 2.5, y: 4 })
    const outcome = controller.pointerUp({ x: 2.5, y: 5.5 })
    expect(outcome.kind).toBe('committed')
    if (outcome.kind !== 'committed') return
    // One new road, plus one extra edge for each existing edge split in two.
    expect(graph.edgeCount).toBe(edges + 1 + outcome.result.splits.length)
    expect(controller.builtRoads).toHaveLength(1)
    expect(controller.preview).toBeUndefined()
    // A second pointer-up without a new gesture does nothing.
    expect(controller.pointerUp({ x: 2.5, y: 5.5 })).toEqual({ kind: 'none' })
    expect(controller.builtRoads).toHaveLength(1)
  })

  it('leaves the graph unchanged on an invalid pointer-up', () => {
    const { controller, graph } = setup()
    const version = graph.version
    controller.pointerDown({ x: 5.5, y: 1.5 })
    const outcome = controller.pointerUp({ x: 5.5, y: 5.5 })
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'obstacle' })
    expect(graph.version).toBe(version)
    expect(controller.builtRoads).toHaveLength(0)
  })

  it('cancel abandons the gesture', () => {
    const { controller, graph } = setup()
    const version = graph.version
    controller.pointerDown({ x: 2.5, y: 1.5 })
    controller.cancel()
    expect(controller.preview).toBeUndefined()
    expect(controller.pointerUp({ x: 2.5, y: 5.5 })).toEqual({ kind: 'none' })
    expect(graph.version).toBe(version)
  })

  it('notifies listeners of changes', () => {
    const { controller } = setup()
    const listener = vi.fn()
    const off = controller.onChange(listener)
    controller.pointerDown({ x: 2.5, y: 1.5 })
    controller.pointerMove({ x: 2.5, y: 3 })
    controller.pointerUp({ x: 2.5, y: 5.5 })
    expect(listener).toHaveBeenCalledTimes(3)
    off()
    controller.pointerDown({ x: 2.5, y: 1.5 })
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('new roads are used by subsequent route queries', () => {
    const { controller, graph } = setup()
    const before = findRoute(graph, TOP_LEFT, BOTTOM_LEFT)
    controller.pointerDown({ x: 1.5, y: 1.5 })
    controller.pointerUp({ x: 1.5, y: 5.5 })
    const after = findRoute(graph, TOP_LEFT, BOTTOM_LEFT)
    expect(before.ok && after.ok).toBe(true)
    if (before.ok && after.ok) {
      expect(after.route.cost).toBeLessThan(before.route.cost)
      expect(after.route.steps).toHaveLength(1)
    }
  })

  it('builds the same road from equivalent gestures at different canvas sizes', () => {
    const results = [
      [1280, 720, { left: 0, top: 60 }],
      [390, 780, { left: 0, top: 96 }],
    ] as const
    const roads = results.map(([w, h, rect]) => {
      const { world, controller } = setup()
      const v = fitViewport(world.width, world.height, w, h, 8)
      const toClient = (p: { x: number; y: number }) => {
        const s = worldToScreen(v, p)
        return [s.x + rect.left, s.y + rect.top] as const
      }
      const [x0, y0] = toClient({ x: 2.5, y: 1.5 })
      const [x1, y1] = toClient({ x: 2.5, y: 5.5 })
      controller.pointerDown(clientToWorld(v, rect, x0, y0))
      const outcome = controller.pointerUp(clientToWorld(v, rect, x1, y1))
      return outcome.kind === 'committed' ? outcome.road : undefined
    })
    expect(roads[0]).toBeDefined()
    expect(roads[0]!.from.x).toBeCloseTo(roads[1]!.from.x)
    expect(roads[0]!.from.y).toBeCloseTo(roads[1]!.from.y)
    expect(roads[0]!.to.x).toBeCloseTo(roads[1]!.to.x)
    expect(roads[0]!.to.y).toBeCloseTo(roads[1]!.to.y)
  })
})

describe('ConstructionController custom commit', () => {
  it('commits through the supplied function', () => {
    const world = asciiWorld(LOOP)
    const graph = createRoadGraph(world)
    const commit = vi.fn((from, to) => to.kind === 'point' ? graph.connectToPoint(from, to.position) : graph.connect(from, to))
    const controller = new ConstructionController(world, graph, undefined, commit)
    controller.pointerDown({ x: 2.5, y: 1.5 })
    expect(controller.pointerUp({ x: 2.5, y: 5.5 }).kind).toBe('committed')
    expect(commit).toHaveBeenCalledTimes(1)
  })
})
