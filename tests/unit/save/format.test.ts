import { describe, expect, it } from 'vitest'
import { parseSave, SAVE_FORMAT, SAVE_VERSION, SaveError, SaveSlot, serializeSave, type SaveData, type SaveStorage } from '../../../src/game/save'

function sample(overrides: Partial<Record<keyof SaveData, unknown>> = {}): Record<string, unknown> {
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: '2026-11-07T08:00:00.000Z',
    seed: 77,
    mode: 'objectives',
    level: 2,
    stepSec: 0.05,
    ticks: 400,
    completedTime: 180,
    completedScore: 850,
    exitedBeforeLevel: 80,
    actions: [
      { tick: 10, action: { type: 'connect', from: { kind: 'node', node: 3 }, to: { kind: 'edge', edge: 7, t: 0.25 }, via: [{ x: 4, y: 5 }] } },
      { tick: 10, action: { type: 'connectToPoint', from: { kind: 'edge', edge: 2, t: 1 }, point: { x: 9.5, y: 3 }, via: [] } },
      { tick: 120, action: { type: 'placeSignal', node: 4, greenSec: 8 } },
      { tick: 130, action: { type: 'removeSignal', node: 4 } },
      { tick: 200, action: { type: 'removeRoad', id: 1 } },
      { tick: 201, action: { type: 'undo' } },
      { tick: 202, action: { type: 'redo' } },
    ],
    fingerprint: 'abc123',
    ...overrides,
  }
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return e instanceof SaveError ? e.code : `other: ${String(e)}`
  }
  return undefined
}

describe('save format', () => {
  it('round-trips a valid save exactly', () => {
    const data = parseSave(JSON.stringify(sample()))
    expect(parseSave(serializeSave(data))).toEqual(data)
    expect(data.actions).toHaveLength(7)
    expect(data.actions[0]!.action).toEqual({ type: 'connect', from: { kind: 'node', node: 3 }, to: { kind: 'edge', edge: 7, t: 0.25 }, via: [{ x: 4, y: 5 }] })
  })

  it('drops unknown extra fields rather than carrying them', () => {
    const data = parseSave(JSON.stringify(sample({ extra: 1 } as never)))
    expect('extra' in data).toBe(false)
  })

  it('rejects text that is not a Snookjam save as corrupt', () => {
    expect(code(() => parseSave('{not json'))).toBe('corrupt')
    expect(code(() => parseSave('[]'))).toBe('corrupt')
    expect(code(() => parseSave(JSON.stringify({ format: 'other' })))).toBe('corrupt')
  })

  it('rejects other versions as unsupported', () => {
    expect(code(() => parseSave(JSON.stringify(sample({ version: 2 }))))).toBe('unsupported-version')
    expect(code(() => parseSave(JSON.stringify(sample({ version: '1' }))))).toBe('unsupported-version')
  })

  it.each([
    ['seed', { seed: -1 }],
    ['seed', { seed: 2 ** 33 }],
    ['mode', { mode: 'arcade' }],
    ['level', { level: 0 }],
    ['level', { level: 1.5 }],
    ['stepSec', { stepSec: 0 }],
    ['ticks', { ticks: -3 }],
    ['completedTime', { completedTime: Number.NaN }],
    ['completedScore', { completedScore: -10 }],
    ['fingerprint', { fingerprint: '' }],
    ['actions', { actions: 'nope' }],
    ['action order', { actions: [{ tick: 5, action: { type: 'undo' } }, { tick: 4, action: { type: 'redo' } }] }],
    ['action past the saved tick', { actions: [{ tick: 401, action: { type: 'undo' } }] }],
    ['unknown action', { actions: [{ tick: 1, action: { type: 'teleport' } }] }],
    ['bad location', { actions: [{ tick: 1, action: { type: 'connect', from: { kind: 'edge', edge: 1, t: 2 }, to: { kind: 'node', node: 1 }, via: [] } }] }],
    ['bad point', { actions: [{ tick: 1, action: { type: 'connectToPoint', from: { kind: 'node', node: 1 }, point: { x: 'a', y: 1 }, via: [] } }] }],
    ['bad signal', { actions: [{ tick: 1, action: { type: 'placeSignal', node: 1, greenSec: -5 } }] }],
  ])('rejects an invalid %s', (_label, overrides) => {
    expect(code(() => parseSave(JSON.stringify(sample(overrides as never))))).toBe('invalid')
  })
})

/** In-memory Web Storage stand-in with switchable failure modes. */
function memoryStorage(fail?: 'quota' | 'blocked'): SaveStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => {
      if (fail === 'blocked') throw new Error('SecurityError')
      return data.get(k) ?? null
    },
    setItem: (k, v) => {
      if (fail === 'quota') throw Object.assign(new Error('full'), { name: 'QuotaExceededError' })
      if (fail === 'blocked') throw new Error('SecurityError')
      data.set(k, v)
    },
    removeItem: (k) => void data.delete(k),
  }
}

describe('SaveSlot', () => {
  const data = parseSave(JSON.stringify(sample()))

  it('writes, reads back, reports existence and clears', () => {
    const store = memoryStorage()
    const slot = new SaveSlot(() => store)
    expect(slot.exists()).toBe(false)
    expect(code(() => slot.read())).toBe('not-found')
    slot.write(data)
    expect(slot.exists()).toBe(true)
    expect(slot.read()).toEqual(data)
    slot.clear()
    expect(slot.exists()).toBe(false)
  })

  it('reports a full storage quota', () => {
    expect(code(() => new SaveSlot(() => memoryStorage('quota')).write(data))).toBe('storage-full')
  })

  it('reports blocked or missing storage without throwing browser errors', () => {
    const blocked = new SaveSlot(() => memoryStorage('blocked'))
    expect(code(() => blocked.write(data))).toBe('storage-unavailable')
    expect(code(() => blocked.read())).toBe('storage-unavailable')
    expect(blocked.exists()).toBe(false)
    expect(() => blocked.clear()).not.toThrow()
    const missing = new SaveSlot(() => undefined)
    expect(code(() => missing.write(data))).toBe('storage-unavailable')
    const throwing = new SaveSlot(() => {
      throw new Error('SecurityError: localStorage is not available')
    })
    expect(code(() => throwing.read())).toBe('storage-unavailable')
  })

  it('surfaces a corrupt stored value as a SaveError', () => {
    const store = memoryStorage()
    store.data.set('snookjam.save', '{"format":"snookjam-save","version":1')
    expect(code(() => new SaveSlot(() => store).read())).toBe('corrupt')
  })
})
