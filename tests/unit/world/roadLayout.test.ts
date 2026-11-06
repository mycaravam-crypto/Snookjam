import { describe, expect, it } from 'vitest'
import { extractRoadLayout } from '../../../src/game/world/roadLayout'

/** Builds a road mask from an ASCII grid where '#' is road. */
function mask(rows: string[]): { width: number; height: number; road: boolean[] } {
  return {
    width: rows[0]!.length,
    height: rows.length,
    road: rows.join('').split('').map((c) => c === '#'),
  }
}

describe('extractRoadLayout', () => {
  it('turns a straight road into one segment between two end nodes', () => {
    const m = mask(['#####'])
    const layout = extractRoadLayout(m.width, m.height, m.road, new Map())
    expect(layout.nodes.map((n) => n.kind)).toEqual(['end', 'end'])
    expect(layout.segments).toHaveLength(1)
    expect(layout.segments[0]).toMatchObject({ length: 4, points: [{ x: 0.5, y: 0.5 }, { x: 4.5, y: 0.5 }] })
  })

  it('creates junction nodes where roads branch and keeps bends as points', () => {
    const m = mask([
      '#....',
      '###..',
      '..#..',
      '..###',
    ])
    const layout = extractRoadLayout(m.width, m.height, m.road, new Map())
    expect(layout.nodes.find((n) => n.kind === 'junction')).toBeUndefined()
    expect(layout.segments).toHaveLength(1)
    expect(layout.segments[0]!.points.length).toBeGreaterThan(2)

    const t = mask(['#####', '..#..', '..#..'])
    const tee = extractRoadLayout(t.width, t.height, t.road, new Map())
    expect(tee.nodes.filter((n) => n.kind === 'junction')).toHaveLength(1)
    expect(tee.segments).toHaveLength(3)
  })

  it('splits loops so no segment starts and ends on the same node', () => {
    const m = mask(['####', '#..#', '####', '#...'])
    const layout = extractRoadLayout(m.width, m.height, m.road, new Map())
    for (const s of layout.segments) expect(s.from).not.toBe(s.to)
  })

  it('handles a closed ring with no natural nodes', () => {
    const m = mask(['###', '#.#', '###'])
    const layout = extractRoadLayout(m.width, m.height, m.road, new Map())
    expect(layout.nodes.length).toBeGreaterThanOrEqual(2)
    expect(layout.segments.reduce((sum, s) => sum + s.length, 0)).toBe(8)
  })

  it('marks special tiles as nodes of the given kind', () => {
    const m = mask(['#####'])
    const layout = extractRoadLayout(m.width, m.height, m.road, new Map([[2, 'settlement']]))
    expect(layout.nodes.find((n) => n.id === 'n2')?.kind).toBe('settlement')
    expect(layout.segments).toHaveLength(2)
  })
})
