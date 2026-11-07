/**
 * Seeded pseudo-random number generation. All procedural content must draw
 * from an Rng so that a seed fully determines the result.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number
  /** Uniformly chosen element; throws on an empty array. */
  pick<T>(items: readonly T[]): T
  /** Returns a shuffled copy (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[]
  getState(): number
  setState(state: number): void
}

/** Mulberry32: small, fast and good enough for game content. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1))
  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError('cannot pick from an empty array')
      return items[int(0, items.length - 1)] as T
    },
    getState: () => state,
    setState(nextState: number): void {
      if (!Number.isInteger(nextState) || nextState < 0 || nextState > 0xffffffff) throw new RangeError('invalid RNG state')
      state = nextState >>> 0
    },
    shuffle<T>(items: readonly T[]): T[] {
      const copy = items.slice()
      for (let i = copy.length - 1; i > 0; i--) {
        const j = int(0, i)
        ;[copy[i], copy[j]] = [copy[j] as T, copy[i] as T]
      }
      return copy
    },
  }
}

/** Normalises a numeric or string seed to an unsigned 32-bit integer. */
export function normalizeSeed(seed: number | string): number {
  if (typeof seed === 'number' && Number.isInteger(seed)) return seed >>> 0
  return hashString(String(seed))
}

/** FNV-1a string hash. */
export function hashString(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Combines integers into a well-mixed 32-bit hash (for derived seeds). */
export function mixSeed(...values: number[]): number {
  let h = 0x9e3779b9
  for (const v of values) {
    h = Math.imul(h ^ (v >>> 0), 0x85ebca6b)
    h ^= h >>> 13
    h = Math.imul(h, 0xc2b2ae35)
    h ^= h >>> 16
  }
  return h >>> 0
}
