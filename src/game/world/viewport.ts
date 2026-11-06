import type { Point } from './types'

/**
 * Maps world coordinates (tiles) to canvas coordinates (CSS pixels).
 * The world is fitted inside the canvas, preserving aspect ratio, centred.
 */
export interface Viewport {
  /** CSS pixels per world unit (tile). */
  readonly scale: number
  readonly offsetX: number
  readonly offsetY: number
  readonly canvasWidth: number
  readonly canvasHeight: number
}

export function fitViewport(
  worldWidth: number,
  worldHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  padding = 0,
): Viewport {
  const availW = Math.max(1, canvasWidth - 2 * padding)
  const availH = Math.max(1, canvasHeight - 2 * padding)
  const scale = Math.min(availW / worldWidth, availH / worldHeight)
  return {
    scale,
    offsetX: (canvasWidth - worldWidth * scale) / 2,
    offsetY: (canvasHeight - worldHeight * scale) / 2,
    canvasWidth,
    canvasHeight,
  }
}

export function worldToScreen(v: Viewport, p: Point): Point {
  return { x: v.offsetX + p.x * v.scale, y: v.offsetY + p.y * v.scale }
}

export function screenToWorld(v: Viewport, p: Point): Point {
  return { x: (p.x - v.offsetX) / v.scale, y: (p.y - v.offsetY) / v.scale }
}
