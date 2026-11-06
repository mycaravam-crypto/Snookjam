import { describe, expect, it } from 'vitest'
import { fitViewport, generateWorld, renderWorld, type RenderContext } from '@game/index'

/** Records canvas calls so rendering can be tested without a real canvas. */
function recordingContext() {
  const calls: { name: string; args: unknown[] }[] = []
  const state: Record<string, unknown> = {}
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return (...args: unknown[]) => {
        calls.push({ name: prop, args })
      }
    },
    set(target, prop: string, value) {
      target[prop] = value
      return true
    },
  }) as unknown as RenderContext
  return { ctx, calls }
}

describe('renderWorld', () => {
  it.each([
    [1280, 720],
    [390, 844],
    [120, 90],
  ])('draws terrain, roads, settlements and portals at %i × %i', (w, h) => {
    const world = generateWorld(77)
    const { ctx, calls } = recordingContext()
    renderWorld(ctx, world, fitViewport(world.width, world.height, w, h))
    const count = (name: string) => calls.filter((c) => c.name === name).length
    expect(count('fillRect')).toBeGreaterThanOrEqual(world.width * world.height)
    expect(count('stroke')).toBeGreaterThanOrEqual(world.roads.segments.length * 2)
    // Each portal draws one filled tunnel mouth.
    expect(count('arc')).toBeGreaterThanOrEqual(world.portals.length * 2)
    expect(count('save')).toBe(count('restore'))
  })

  it('stays within the canvas bounds for terrain tiles', () => {
    const world = generateWorld(77)
    const { ctx, calls } = recordingContext()
    const v = fitViewport(world.width, world.height, 800, 600)
    renderWorld(ctx, world, v)
    for (const c of calls.filter((c) => c.name === 'fillRect').slice(1)) {
      const [x, y] = c.args as number[]
      expect(x).toBeGreaterThanOrEqual(-1)
      expect(y).toBeGreaterThanOrEqual(-1)
      expect(x!).toBeLessThanOrEqual(800)
      expect(y!).toBeLessThanOrEqual(600)
    }
  })

  it('does not mutate the world', () => {
    const world = generateWorld(77)
    const before = JSON.stringify(world)
    renderWorld(recordingContext().ctx, world, fitViewport(40, 30, 640, 480))
    expect(JSON.stringify(world)).toBe(before)
  })
})

describe('renderWorld on a rotated viewport', () => {
  it('keeps every terrain tile inside a portrait canvas', () => {
    const world = generateWorld(77)
    const { ctx, calls } = recordingContext()
    const v = fitViewport(world.width, world.height, 390, 750, 8, { rotateIfLargerBy: 1.15 })
    expect(v.rotation).toBe(1)
    renderWorld(ctx, world, v)
    for (const c of calls.filter((c) => c.name === 'fillRect').slice(1)) {
      const [x, y] = c.args as number[]
      expect(x).toBeGreaterThanOrEqual(-1)
      expect(y).toBeGreaterThanOrEqual(-1)
      expect(x!).toBeLessThanOrEqual(390)
      expect(y!).toBeLessThanOrEqual(750)
    }
  })
})
