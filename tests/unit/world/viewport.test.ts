import { describe, expect, it } from 'vitest'
import {
  clientToWorld,
  fitViewport,
  generateWorld,
  screenAngle,
  screenToWorld,
  tileAtPoint,
  worldRectToScreen,
  worldToScreen,
} from '@game/world'

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

describe('rotated viewport', () => {
  it('rotates a wide map on a tall canvas only when it is clearly larger', () => {
    expect(fitViewport(40, 30, 390, 750, 8, { rotateIfLargerBy: 1.15 }).rotation).toBe(1)
    expect(fitViewport(40, 30, 1280, 720, 8, { rotateIfLargerBy: 1.15 }).rotation).toBe(0)
    // Nearly square canvas: rotating gains too little.
    expect(fitViewport(40, 30, 500, 520, 8, { rotateIfLargerBy: 1.15 }).rotation).toBe(0)
    // Without the option, never rotate.
    expect(fitViewport(40, 30, 390, 750, 8).rotation).toBe(0)
  })

  it('uses a larger scale when rotated and stays inside the canvas', () => {
    const upright = fitViewport(40, 30, 390, 750, 8)
    const turned = fitViewport(40, 30, 390, 750, 8, { rotateIfLargerBy: 1.15 })
    expect(turned.scale).toBeGreaterThan(upright.scale * 1.15)
    for (const corner of [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 30 }, { x: 40, y: 30 }]) {
      const p = worldToScreen(turned, corner)
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(390)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(750)
    }
  })

  it('turns the map clockwise: world north is screen right, world east is screen down', () => {
    const v = fitViewport(40, 30, 390, 750, 8, { rotateIfLargerBy: 1.15 })
    const origin = worldToScreen(v, { x: 0, y: 0 })
    const east = worldToScreen(v, { x: 1, y: 0 })
    const south = worldToScreen(v, { x: 0, y: 1 })
    expect(east.y - origin.y).toBeCloseTo(v.scale)
    expect(east.x).toBeCloseTo(origin.x)
    expect(south.x - origin.x).toBeCloseTo(-v.scale)
    expect(screenAngle(v, 0)).toBeCloseTo(Math.PI / 2)
  })

  it('round-trips world, screen and client coordinates when rotated', () => {
    const v = fitViewport(40, 30, 390, 750, 8, { rotateIfLargerBy: 1.15 })
    const rect = { left: 0, top: 96 }
    for (const p of [{ x: 0, y: 0 }, { x: 12.25, y: 7.5 }, { x: 40, y: 30 }]) {
      const back = screenToWorld(v, worldToScreen(v, p))
      expect(back.x).toBeCloseTo(p.x)
      expect(back.y).toBeCloseTo(p.y)
      const s = worldToScreen(v, p)
      const fromClient = clientToWorld(v, rect, s.x + rect.left, s.y + rect.top)
      expect(fromClient.x).toBeCloseTo(p.x)
      expect(fromClient.y).toBeCloseTo(p.y)
    }
  })

  it('maps world rectangles to axis-aligned screen rectangles', () => {
    const v = fitViewport(40, 30, 390, 750, 8, { rotateIfLargerBy: 1.15 })
    const r = worldRectToScreen(v, 3, 4, 2, 1)
    expect(r.width).toBeCloseTo(v.scale)
    expect(r.height).toBeCloseTo(2 * v.scale)
    const topLeft = worldToScreen(v, { x: 3, y: 5 })
    expect(r.x).toBeCloseTo(topLeft.x)
    expect(r.y).toBeCloseTo(topLeft.y)
  })
})
