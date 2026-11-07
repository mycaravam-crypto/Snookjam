import type { ObjectiveKind, ObjectiveProgress } from '@game/index'

/** Short goal text for an objective, e.g. "Complete 70 journeys". */
export function objectiveGoal(kind: ObjectiveKind, target: number): string {
  switch (kind) {
    case 'journeys':
      return `Complete ${target} journeys`
    case 'throughput':
      return `Finish at ${target}+ journeys/min`
    case 'averageWait':
      return `Average wait ≤ ${target} s`
  }
}

/** Current value against the target, e.g. "23 / 70" or "4.2 s". */
export function objectiveValue(o: ObjectiveProgress): string {
  if (o.value === undefined) return '—'
  switch (o.kind) {
    case 'journeys':
      return `${o.value} / ${o.target}`
    case 'throughput':
      return `${o.value.toFixed(1)}/min`
    case 'averageWait':
      return `${o.value.toFixed(1)} s`
  }
}

export const STATUS_ICONS = { met: '✓', failed: '✕', pending: '' } as const
