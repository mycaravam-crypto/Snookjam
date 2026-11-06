import { describe, expect, it } from 'vitest'
import { ConstructionController, createRoadGraph, fitViewport, renderBuiltRoads, renderConstructionPreview } from '@game/index'
import type { ConstructionContext } from '@game/index'
import { asciiWorld, LOOP } from './fixtures'

function recorder() {
  const calls: { name: string; args: unknown[] }[] = []
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, p: string) => (p in t ? t[p] : (...args: unknown[]) => void calls.push({ name: p, args })),
    set: (t, p: string, v) => ((t[p] = v), true),
  }) as unknown as ConstructionContext
  return { ctx, calls }
}

describe('construction rendering', () => {
  const world = asciiWorld(LOOP)
  const v = fitViewport(world.width, world.height, 600, 400)

  it('draws valid previews solid and invalid previews dashed', () => {
    const controller = new ConstructionController(world, createRoadGraph(world))
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
    renderBuiltRoads(built.ctx, [{ id: 0, from: { x: 1, y: 1 }, to: { x: 1, y: 5 } }], v)
    expect(built.calls.filter((c) => c.name === 'stroke').length).toBeGreaterThanOrEqual(2)
  })
})
