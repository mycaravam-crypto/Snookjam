/**
 * Freehand path geometry (#18): turns a captured pointer trajectory into a
 * clean polyline suitable for road geometry. Pure functions in world
 * coordinates; no pointer events, rendering or graph access here.
 *
 * Pipeline: capture (spacing-filtered samples) -> anchor to snapped endpoints
 * -> resample at even spacing -> smooth (removes jitter, keeps shape) ->
 * simplify (few, long segments). Resampling first makes smoothing act over a
 * fixed distance, however fast or slowly the pointer moved.
 */
import { distance, type Point } from '../roads/graph'

export interface PathOptions {
  /** Ignore pointer samples closer than this (tiles) to the previous one. */
  readonly sampleSpacing: number
  /** Spacing (tiles) the path is resampled at before smoothing. */
  readonly resampleSpacing: number
  /** Passes of [1 2 1]/4 smoothing over the resampled path; 0 disables smoothing. */
  readonly smoothingPasses: number
  /** Ramer-Douglas-Peucker tolerance in tiles: max deviation from the drawn shape. */
  readonly simplifyTolerance: number
  /**
   * Shortest segment between bends, in tiles. Keeps per-edge capacity
   * meaningful (capacity is derived from edge length) and avoids micro-edges.
   */
  readonly minSegmentLength: number
}

export const DEFAULT_PATH_OPTIONS: PathOptions = Object.freeze({
  sampleSpacing: 0.08,
  resampleSpacing: 0.15,
  smoothingPasses: 1,
  simplifyTolerance: 0.1,
  minSegmentLength: 0.5,
})

/** Appends `point` to `samples` unless it is within `spacing` of the last sample. Returns whether it was added. */
export function appendSample(samples: Point[], point: Point, spacing: number): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
  const last = samples[samples.length - 1]
  if (last && distance(last, point) < spacing) return false
  samples.push({ x: point.x, y: point.y })
  return true
}

/**
 * Smooths a polyline with repeated [1 2 1]/4 averaging. Endpoints are fixed,
 * so a smoothed road still meets the network exactly where it was snapped.
 */
export function smoothPath(points: readonly Point[], passes: number): Point[] {
  let current = points.map((p) => ({ x: p.x, y: p.y }))
  if (current.length < 3) return current
  for (let pass = 0; pass < passes; pass++) {
    const next = [current[0]!]
    for (let i = 1; i < current.length - 1; i++) {
      const a = current[i - 1]!
      const b = current[i]!
      const c = current[i + 1]!
      // Preserve intentional corners. Compare direction over a wider window
      // than one resampled interval so tight curves are not mistaken for jitter.
      const before = current[Math.max(0, i - 2)]!
      const after = current[Math.min(current.length - 1, i + 2)]!
      const inX = b.x - before.x
      const inY = b.y - before.y
      const outX = after.x - b.x
      const outY = after.y - b.y
      const lengths = Math.hypot(inX, inY) * Math.hypot(outX, outY)
      const direction = lengths > 0 ? (inX * outX + inY * outY) / lengths : 1
      if (direction < Math.cos(Math.PI / 4)) {
        next.push(b)
      } else {
        next.push({ x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 })
      }
    }
    next.push(current[current.length - 1]!)
    current = next
  }
  return current
}

/** Resamples a polyline at (at most) `spacing` intervals, keeping every original vertex's segment endpoints. */
export function resamplePath(points: readonly Point[], spacing: number): Point[] {
  if (points.length < 2 || !(spacing > 0)) return points.map((p) => ({ x: p.x, y: p.y }))
  const out: Point[] = [{ x: points[0]!.x, y: points[0]!.y }]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    const n = Math.max(1, Math.ceil(distance(a, b) / spacing))
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n })
  }
  return out
}

/** Ramer-Douglas-Peucker simplification; keeps both endpoints. */
export function simplifyPath(points: readonly Point[], tolerance: number): Point[] {
  if (points.length < 3) return points.map((p) => ({ x: p.x, y: p.y }))
  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!
    let worst = -1
    let worstDist = tolerance
    for (let i = lo + 1; i < hi; i++) {
      const d = pointSegmentDistance(points[i]!, points[lo]!, points[hi]!)
      if (d > worstDist) {
        worst = i
        worstDist = d
      }
    }
    if (worst >= 0) {
      keep[worst] = true
      stack.push([lo, worst], [worst, hi])
    }
  }
  return points.filter((_, i) => keep[i]).map((p) => ({ x: p.x, y: p.y }))
}

/**
 * Enforces a preferred minimum edge length without flattening meaningful bends.
 * A short segment is merged only when removing its vertex stays within the
 * same geometric error budget used by path simplification. Tight bends may
 * therefore retain a shorter edge rather than being replaced by a shortcut.
 */
export function enforceMinSegment(points: readonly Point[], minLength: number, tolerance = 0.1): Point[] {
  const result = points.map((p) => ({ x: p.x, y: p.y }))
  if (result.length < 3) return result

  let changed = true
  while (changed && result.length > 2) {
    changed = false
    for (let i = 1; i < result.length - 1; i++) {
      const previous = result[i - 1]!
      const current = result[i]!
      const next = result[i + 1]!
      if (distance(previous, current) >= minLength && distance(current, next) >= minLength) continue
      if (pointSegmentDistance(current, previous, next) > tolerance) continue
      result.splice(i, 1)
      changed = true
      break
    }
  }
  return result
}

/**
 * Builds road geometry from a freehand trajectory. `start` and `end` are the
 * (snapped) road endpoints; `samples` is the raw pointer path. Samples within
 * `minSegmentLength` of either endpoint are discarded, so the snap jump does
 * not leave a kink. Returns the full polyline including both endpoints.
 */
export function buildRoadPath(
  start: Point,
  end: Point,
  samples: readonly Point[],
  options: PathOptions = DEFAULT_PATH_OPTIONS,
): Point[] {
  if (samples.length === 0) return [{ x: start.x, y: start.y }, { x: end.x, y: end.y }]
  const trim = options.minSegmentLength
  const interior = samples.filter((p) => distance(p, start) >= trim && distance(p, end) >= trim)
  const raw = [start, ...interior, end]
  const smoothed = smoothPath(resamplePath(raw, options.resampleSpacing), options.smoothingPasses)
  const simplified = simplifyPath(smoothed, options.simplifyTolerance)
  return enforceMinSegment(simplified, options.minSegmentLength, options.simplifyTolerance)
}

/** Total length of a polyline in tiles. */
export function pathLength(points: readonly Point[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1]!, points[i]!)
  return total
}

/** Shortest distance from `p` to segment ab. */
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}
