import type { Point } from './types'

/**
 * Maps world coordinates (tiles) to canvas coordinates (CSS pixels).
 * The world is fitted inside the canvas, preserving aspect ratio, centred.
 *
 * With `rotation: 1` the world is drawn a quarter turn clockwise, so a wide
 * map fills a tall (portrait) canvas: world north points to screen right.
 * Rotation is purely presentational; world data and coordinates are
 * unchanged, and all conversions below account for it.
 */
export interface Viewport {
  /** CSS pixels per world unit (tile). */
  readonly scale: number
  /** Screen position of the drawn map's top-left corner. */
  readonly offsetX: number
  readonly offsetY: number
  readonly canvasWidth: number
  readonly canvasHeight: number
  /** Quarter turns clockwise (0 = none). */
  readonly rotation?: 0 | 1
  /** World height in tiles; needed when rotated. */
  readonly worldHeight?: number
}

export interface FitOptions {
  /**
   * Allow a quarter turn when it makes the map at least this many times
   * larger (e.g. 1.15). Undefined or Infinity never rotates.
   */
  readonly rotateIfLargerBy?: number
}

export function fitViewport(
  worldWidth: number,
  worldHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  padding = 0,
  options: FitOptions = {},
): Viewport {
  const availW = Math.max(1, canvasWidth - 2 * padding)
  const availH = Math.max(1, canvasHeight - 2 * padding)
  const upright = Math.min(availW / worldWidth, availH / worldHeight)
  const turned = Math.min(availW / worldHeight, availH / worldWidth)
  const threshold = options.rotateIfLargerBy ?? Infinity
  if (turned >= upright * threshold) {
    return {
      scale: turned,
      offsetX: (canvasWidth - worldHeight * turned) / 2,
      offsetY: (canvasHeight - worldWidth * turned) / 2,
      canvasWidth,
      canvasHeight,
      rotation: 1,
      worldHeight,
    }
  }
  return {
    scale: upright,
    offsetX: (canvasWidth - worldWidth * upright) / 2,
    offsetY: (canvasHeight - worldHeight * upright) / 2,
    canvasWidth,
    canvasHeight,
    rotation: 0,
    worldHeight,
  }
}

function isTurned(v: Viewport): boolean {
  return v.rotation === 1
}

export function worldToScreen(v: Viewport, p: Point): Point {
  if (isTurned(v)) {
    return { x: v.offsetX + ((v.worldHeight ?? 0) - p.y) * v.scale, y: v.offsetY + p.x * v.scale }
  }
  return { x: v.offsetX + p.x * v.scale, y: v.offsetY + p.y * v.scale }
}

export function screenToWorld(v: Viewport, p: Point): Point {
  if (isTurned(v)) {
    return { x: (p.y - v.offsetY) / v.scale, y: (v.worldHeight ?? 0) - (p.x - v.offsetX) / v.scale }
  }
  return { x: (p.x - v.offsetX) / v.scale, y: (p.y - v.offsetY) / v.scale }
}

/** Screen angle (radians, canvas convention) for a world-space angle. */
export function screenAngle(v: Viewport, worldAngle: number): number {
  return isTurned(v) ? worldAngle + Math.PI / 2 : worldAngle
}

/** Axis-aligned screen rectangle covering a world rectangle. */
export function worldRectToScreen(
  v: Viewport,
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const a = worldToScreen(v, { x, y })
  const b = worldToScreen(v, { x: x + width, y: y + height })
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  }
}

/**
 * Converts a pointer position in page client coordinates to world
 * coordinates, given the canvas's bounding rectangle in CSS pixels.
 * Works for any canvas size because the viewport is in CSS pixels too.
 */
export function clientToWorld(
  v: Viewport,
  rect: { readonly left: number; readonly top: number },
  clientX: number,
  clientY: number,
): Point {
  return screenToWorld(v, { x: clientX - rect.left, y: clientY - rect.top })
}
