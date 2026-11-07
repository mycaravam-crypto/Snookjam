import { describe, expect, it } from 'vitest'
import { constructionOptions, ConstructionController, createRoadGraph, snapEnd } from '@game/index'
import { RoadGraph } from '../../../src/game/roads'
import { asciiWorld, LOOP } from './fixtures'

/** Two parallel roads, y = 0 and y = 3, from x = 0 to x = 10. */
function parallel() {
  return RoadGraph.fromLayout({
    nodes: [
      { id: 0, x: 0, y: 0 }, { id: 1, x: 10, y: 0 },
      { id: 2, x: 0, y: 3 }, { id: 3, x: 10, y: 3 },
    ],
    segments: [{ from: 0, to: 1 }, { from: 2, to: 3 }],
  })
}

const options = constructionOptions({ endSnapDistance: 2, endSnapRelease: 2.5 })
const roadOf = (graph: RoadGraph, y: number) => graph.edges().find((e) => graph.getNode(e.a)!.position.y === y)!.id

describe('end-snap hysteresis (#29)', () => {
  it('snaps to the nearest road when nothing is latched', () => {
    const graph = parallel()
    expect(snapEnd(graph, { x: 5, y: 1.6 }, options)?.position).toEqual({ x: 5, y: 3 })
  })

  it('keeps the latched road while the pointer stays within the release radius', () => {
    const graph = parallel()
    const first = snapEnd(graph, { x: 5, y: 1.4 }, options)!
    expect(first.location).toMatchObject({ kind: 'edge', edge: roadOf(graph, 0) })
    // Closer to the other road now, but still within 2.5 tiles of the latched one.
    const jitter = snapEnd(graph, { x: 5.3, y: 1.6 }, options, first.location)!
    expect(jitter.location).toMatchObject({ kind: 'edge', edge: roadOf(graph, 0) })
    expect(jitter.position.x).toBeCloseTo(5.3)
    expect(jitter.position.y).toBeCloseTo(0)
  })

  it('releases the latch beyond the release radius', () => {
    const graph = parallel()
    const first = snapEnd(graph, { x: 5, y: 1.4 }, options)!
    const moved = snapEnd(graph, { x: 5, y: 2.6 }, options, first.location)!
    expect(moved.location).toMatchObject({ kind: 'edge', edge: roadOf(graph, 3) })
    expect(snapEnd(graph, { x: 5, y: 8 }, options, first.location)).toBeUndefined()
  })

  it('a latch on a junction follows any road meeting it', () => {
    const graph = RoadGraph.fromLayout({
      nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 6, y: 0 }, { id: 2, x: 0, y: 6 }],
      segments: [{ from: 0, to: 1 }, { from: 0, to: 2 }],
    })
    const near = graph.nearestLocationOn({ kind: 'node', node: 0 }, { x: 0.2, y: 3 }, 2.5)
    expect(near?.location).toMatchObject({ kind: 'edge' })
    expect(near?.position.x).toBeCloseTo(0)
    expect(near?.position.y).toBeCloseTo(3)
    expect(graph.nearestLocationOn({ kind: 'node', node: 99 }, { x: 0, y: 0 }, 2.5)).toBeUndefined()
  })

  it('rejects a release radius smaller than the snap radius', () => {
    expect(() => constructionOptions({ endSnapDistance: 2, endSnapRelease: 1.5 })).toThrow(RangeError)
  })

  it('the controller preview and the committed road use the latched road', () => {
    // Start on the right-hand vertical road; the pointer then hovers between
    // the top (y = 1.5) and bottom (y = 5.5) roads.
    const world = asciiWorld(LOOP)
    const graph = createRoadGraph(world)
    const controller = new ConstructionController(world, graph, options)
    expect(controller.pointerDown({ x: 9.5, y: 3.5 })).toBe(true)
    controller.pointerMove({ x: 7.5, y: 3.4 })
    expect(controller.preview?.to.y).toBeCloseTo(1.5)
    controller.pointerMove({ x: 7.5, y: 3.6 })
    expect(controller.preview?.to.y).toBeCloseTo(1.5)
    // A new gesture starts unlatched.
    controller.cancel()
    controller.pointerDown({ x: 9.5, y: 3.5 })
    controller.pointerMove({ x: 7.5, y: 3.6 })
    expect(controller.preview?.to.y).toBeCloseTo(5.5)
  })
})
