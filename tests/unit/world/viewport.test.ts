import { describe, expect, it } from 'vitest'
import { fitViewport, screenToWorld, tileAtPoint, worldToScreen, generateWorld } from '@game/world'

describe('viewport', () => {
  const sizes: [number, number][] = [
    [1280, 720],
    [1920, 1080],
    [390, 844],
    [844, 390],
    [100, 100],
  ]

  it.each(sizes)('fits a 40 × 30 world inside %i × %i and centres it', (w, h) => {
    const v = fitViewport(40, 30, w, h)
    expect(40 * v.scale).toBeLessThanOrEqual(w + 1e-9)
    expect(30 * v.scale).toBeLessThanOrEqual(h + 1e-9)
    const fillsOneAxis = Math.abs(40 * v.scale - w) < 1e-9 || Math.abs(30 * v.scale - h) < 1e-9
    expect(fillsOneAxis).toBe(true)
    expect(v.offsetX).toBeCloseTo((w - 40 * v.scale) / 2)
    expect(v.offsetY).toBeCloseTo((h - 30 * v.scale) / 2)
  })

  it.each(sizes)('round-trips world and screen coordinates at %i × %i', (w, h) => {
    const v = fitViewport(40, 30, w, h, 8)
    for (const p of [{ x: 0, y: 0 }, { x: 12.25, y: 7.5 }, { x: 40, y: 30 }]) {
      const back = screenToWorld(v, worldToScreen(v, p))
      expect(back.x).toBeCloseTo(p.x)
      expect(back.y).toBeCloseTo(p.y)
    }
  })

  it('finds the tile under a world point and rejects points off the map', () => {
    const world = generateWorld(3)
    expect(tileAtPoint(world, { x: 3.9, y: 0.1 })).toEqual({ tx: 3, ty: 0 })
    expect(tileAtPoint(world, { x: -0.1, y: 2 })).toBeUndefined()
    expect(tileAtPoint(world, { x: 40, y: 2 })).toBeUndefined()
  })
})
