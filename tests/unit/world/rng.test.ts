import { describe, expect, it } from 'vitest'
import { createRng, normalizeSeed } from '@game/world'

describe('seeded rng', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = createRng(99)
    const b = createRng(99)
    const seqA = Array.from({ length: 20 }, () => a.next())
    const seqB = Array.from({ length: 20 }, () => b.next())
    expect(seqA).toEqual(seqB)
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true)
  })

  it('produces integers in the inclusive range', () => {
    const rng = createRng(5)
    const values = Array.from({ length: 500 }, () => rng.int(2, 4))
    expect(new Set(values)).toEqual(new Set([2, 3, 4]))
  })

  it('normalises numeric and string seeds', () => {
    expect(normalizeSeed(7)).toBe(7)
    expect(normalizeSeed('abc')).toBe(normalizeSeed('abc'))
    expect(normalizeSeed('abc')).not.toBe(normalizeSeed('abd'))
  })
})
