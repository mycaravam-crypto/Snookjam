import type { SessionSnapshot } from '@game/index'

export function snap(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    state: 'running',
    level: 2,
    seed: 99,
    levelTime: 75.4,
    levelDuration: 180,
    timeRemaining: 104.6,
    totalTime: 255.4,
    congestion: 12.6,
    congestionLevel: 'normal',
    activeVehicles: 17,
    pendingVehicles: 0,
    vehiclesExited: 40,
    ...overrides,
  }
}
