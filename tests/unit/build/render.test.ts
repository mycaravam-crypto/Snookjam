import { describe, expect, it } from 'vitest'
import { constructionOptions, ConstructionController, createRoadGraph, fitViewport, renderBuiltRoads, renderConstructionPreview } from '@game/index'
import type { ConstructionContext } from '@game/index'
import { findRoadIntersections, findRoadJunctions, ROAD_EDGE_WIDTH, ROAD_SURFACE_WIDTH, strokeRoads } from '@game/render/roadStyle'
import { asciiWorld, LOOP } from './fixtures'

function recorder() {
  const calls: { name: string; args: unknown[] }[] = []
  const widths: number[] = []
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, p: string) => (p in t ? t[p] : (...args: unknown[]) => void calls.push({ name: p, args })),
    set: (t, p, v) => {
      if (p === 'lineWidth') widths.push(v as number)
      if (typeof p === 'string') t[p] = v
      return true
    },
  }) as unknown as ConstructionContext
  return { ctx, calls, widths }
}

describe('construction rendering', () => {
  const world = asciiWorld(LOOP)
  const v = fitViewport(world.width, world.height, 600, 400)

  it('uses the finished two-lane road footprint for the live preview', () => {
    const controller = new ConstructionController(world, createRoadGraph(world))
    controller.pointerDown({ x: 2.5, y: 1.5 })
    controller.pointerMove({ x: 2.5, y: 5.5 })
    const preview = recorder()
    renderConstructionPreview(preview.ctx, controller.preview, undefined, v)
    expect(preview.widths.slice(0, 2)).toEqual([
      Math.max(2, v.scale * ROAD_EDGE_WIDTH),
      Math.max(2, v.scale * ROAD_SURFACE_WIDTH),
    ])
  })

  it('draws valid previews solid and invalid previews dashed', () => {
    const options = constructionOptions({ endSnapDistance: 1.25, endSnapRelease: 1.25 })
    const controller = new ConstructionController(world, createRoadGraph(world), options)
    controller.pointerDown({ x: 2.5, y: 1.5 })
    controller.pointerMove({ x: 2.5, y: 5.5 })
    const valid = recorder()
    renderConstructionPreview(valid.ctx, controller.preview, undefined, v)
    const dashes = (calls: { name: string; args: unknown[] }[]) =>
      calls.filter((c) => c.name === 'setLineDash' && (c.args[0] as number[]).length > 0).length
    expect(dashes(valid.calls)).toBe(0)

    controller.pointerMove({ x: 2.5, y: 3.2 })
    const invalid = recorder()
    renderConstructionPreview(invalid.ctx, controller.preview, undefined, v)
    expect(dashes(invalid.calls)).toBe(1)
  })

  it('draws nothing without a preview or feedback, and draws built roads', () => {
    const empty = recorder()
    renderConstructionPreview(empty.ctx, undefined, undefined, v)
    expect(empty.calls.filter((c) => c.name === 'stroke')).toHaveLength(0)

    const built = recorder()
    renderBuiltRoads(built.ctx, [{ id: 0, from: { x: 1, y: 1 }, to: { x: 1, y: 5 }, points: [{ x: 1, y: 1 }, { x: 1, y: 5 }] }], v)
    expect(built.calls.filter((c) => c.name === 'stroke').length).toBeGreaterThanOrEqual(2)
  })

  it('clears lane markings at crossings without adding patches to ordinary bends', () => {
    const crossing = recorder()
    strokeRoads(crossing.ctx, v, [
      [{ x: 2, y: 4 }, { x: 8, y: 4 }],
      [{ x: 5, y: 1 }, { x: 5, y: 7 }],
    ])
    expect(crossing.calls.filter((call) => call.name === 'arc')).toHaveLength(3)

    const bend = recorder()
    strokeRoads(bend.ctx, v, [[{ x: 2, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 6 }]])
    expect(bend.calls.filter((call) => call.name === 'arc')).toHaveLength(0)
  })

  it('blends shared road footprints even when lane markings are hidden', () => {
    const crossing = recorder()
    const zoomedOut = { ...v, scale: 5 }
    strokeRoads(crossing.ctx, zoomedOut, [
      [{ x: 2, y: 4 }, { x: 8, y: 4 }],
      [{ x: 5, y: 1 }, { x: 5, y: 7 }],
    ])
    expect(crossing.calls.filter((call) => call.name === 'arc')).toHaveLength(2)
    expect(crossing.calls.filter((call) => call.name === 'fill')).toHaveLength(2)
  })
})
