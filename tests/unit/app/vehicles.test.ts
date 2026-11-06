import { describe, expect, it } from 'vitest'
import { fitViewport, GameSession, renderVehicles, type VehicleContext } from '@game/index'

describe('renderVehicles', () => {
  it('draws one car per vehicle without mutating the sim', () => {
    const session = new GameSession({ seed: 5 })
    session.start()
    for (let i = 0; i < 40; i++) session.tick()
    const calls: string[] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, p: string) => (p in t ? t[p] : () => void calls.push(p)),
      set: (t, p: string, v) => ((t[p] = v), true),
    }) as unknown as VehicleContext
    const before = JSON.stringify(session.sim.vehicles())
    renderVehicles(ctx, session.sim, fitViewport(40, 30, 800, 600))
    const count = session.sim.vehicles().length
    expect(count).toBeGreaterThan(0)
    expect(calls.filter((c) => c === 'rotate')).toHaveLength(count)
    expect(JSON.stringify(session.sim.vehicles())).toBe(before)
  })
})
