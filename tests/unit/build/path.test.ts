import { describe, expect, it } from 'vitest'
import {
  appendSample,
  buildRoadPath,
  DEFAULT_PATH_OPTIONS,
  enforceMinSegment,
  pathLength,
  pointSegmentDistance,
  simplifyPath,
  smoothPath,
  type Point,
} from '@game/index'

/** Deterministic pseudo-jitter in [-amp, amp]. */
const jitter = (i: number, amp: number) => amp * Math.sin(i * 12.9898) * Math.cos(i * 78.233)

/** Samples of a semicircle of radius 3 centred on (5, 5), bulging upwards. */
function arc(n: number, noise = 0): Point[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = Math.PI * (1 - i / n)
    return { x: 5 + 3 * Math.cos(a) + jitter(i, noise), y: 5 - 3 * Math.sin(a) + jitter(i + 100, noise) }
  })
}

describe('path capture', () => {
  it('records samples at least `spacing` apart and ignores non-finite points', () => {
    const samples: Point[] = []
    expect(appendSample(samples, { x: 0, y: 0 }, 0.5)).toBe(true)
    expect(appendSample(samples, { x: 0.2, y: 0 }, 0.5)).toBe(false)
    expect(appendSample(samples, { x: 0.6, y: 0 }, 0.5)).toBe(true)
    expect(appendSample(samples, { x: Number.NaN, y: 0 }, 0.5)).toBe(false)
    expect(samples).toEqual([
      { x: 0, y: 0 },
      { x: 0.6, y: 0 },
    ])
  })
})

describe('smoothPath', () => {
  it('keeps endpoints fixed and reduces jitter', () => {
    const noisy = arc(60, 0.15)
    const smooth = smoothPath(noisy, 3)
    expect(smooth[0]).toEqual(noisy[0])
    expect(smooth[smooth.length - 1]).toEqual(noisy[noisy.length - 1])
    const error = (pts: Point[]) =>
      pts.slice(1, -1).reduce((sum, p) => sum + Math.abs(Math.hypot(p.x - 5, p.y - 5) - 3), 0) / (pts.length - 2)
    expect(error(smooth)).toBeLessThan(error(noisy) / 2)
  })

  it('preserves the overall shape', () => {
    const smooth = smoothPath(arc(40), 3)
    const top = smooth[20]!
    expect(top.x).toBeCloseTo(5, 6)
    expect(top.y).toBeLessThan(2.1) // the arc's apex is at y = 2
  })

  it('is a no-op for two points or zero passes', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]
    expect(smoothPath(line, 5)).toEqual(line)
    expect(smoothPath(arc(4), 0)).toEqual(arc(4))
  })
})

describe('simplifyPath', () => {
  it('collapses collinear samples to a single segment', () => {
    const line = Array.from({ length: 11 }, (_, i) => ({ x: i, y: 2 }))
    expect(simplifyPath(line, 0.1)).toEqual([
      { x: 0, y: 2 },
      { x: 10, y: 2 },
    ])
  })

  it('keeps corners and stays within tolerance of the input', () => {
    const corner = [
      ...Array.from({ length: 6 }, (_, i) => ({ x: i, y: 0 })),
      ...Array.from({ length: 5 }, (_, i) => ({ x: 5, y: i + 1 })),
    ]
    expect(simplifyPath(corner, 0.1)).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 },
    ])
    const curve = arc(50)
    const simple = simplifyPath(curve, 0.2)
    expect(simple.length).toBeLessThan(curve.length / 3)
    for (const p of curve) {
      const d = Math.min(...simple.slice(1).map((q, i) => pointSegmentDistance(p, simple[i]!, q)))
      expect(d).toBeLessThanOrEqual(0.2 + 1e-9)
    }
  })
})

describe('enforceMinSegment', () => {
  it('merges short near-collinear segments but keeps a meaningful tight bend', () => {
    const straight = [
      { x: 0, y: 0 },
      { x: 0.3, y: 0.02 },
      { x: 2, y: 0 },
      { x: 2.2, y: 0.01 },
      { x: 4, y: 0 },
    ]
    expect(enforceMinSegment(straight, 1)).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ])

    const bend = [
      { x: 0, y: 0 },
      { x: 0.4, y: 0 },
      { x: 0.55, y: 0.35 },
      { x: 0.8, y: 0.8 },
    ]
    expect(enforceMinSegment(bend, 0.5)).toEqual(bend)
  })
})

describe('buildRoadPath', () => {
  it('anchors the path to the snapped endpoints and keeps a curved shape', () => {
    const samples = arc(40, 0.05)
    const start = { x: 2, y: 5.4 } // snapped positions differ from the raw ends
    const end = { x: 8, y: 5.4 }
    const path = buildRoadPath(start, end, samples)
    expect(path[0]).toEqual(start)
    expect(path[path.length - 1]).toEqual(end)
    expect(path.length).toBeGreaterThan(3)
    // Still bulges up towards the apex: far from the straight chord.
    expect(Math.min(...path.map((p) => p.y))).toBeLessThan(2.6)
    expect(pathLength(path)).toBeGreaterThan(8)
    for (let i = 1; i < path.length; i++) {
      expect(Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y)).toBeGreaterThanOrEqual(
        DEFAULT_PATH_OPTIONS.minSegmentLength - 1e-9,
      )
    }
  })

  it('gives a straight road when no samples lie between the ends', () => {
    expect(buildRoadPath({ x: 0, y: 0 }, { x: 5, y: 0 }, [{ x: 0.2, y: 0.1 }, { x: 4.9, y: 0 }])).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
    ])
  })
})
