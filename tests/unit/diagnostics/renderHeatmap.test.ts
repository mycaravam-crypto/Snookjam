import { describe, expect, it } from 'vitest'
import { fitViewport, heatColor, NetworkMonitor, renderHeatmap, RoadGraph, type RenderContext, type TrafficSim } from '@game/index'

function recordingContext() {
  const calls: { name: string; args: unknown[]; stroke?: unknown }[] = []
  const state: Record<string, unknown> = {}
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      return (...args: unknown[]) => calls.push({ name: prop, args, stroke: target.strokeStyle })
    },
    set(target, prop: string, value) {
      target[prop] = value
      return true
    },
  }) as unknown as RenderContext
  return { ctx, calls }
}

describe('heatColor', () => {
  it('runs from pale yellow to red with rising opacity, clamped to [0, 1]', () => {
    expect(heatColor(0)).toBe('rgba(255, 224, 102, 0.350)')
    expect(heatColor(0.5)).toBe('rgba(245, 140, 20, 0.600)')
    expect(heatColor(1)).toBe('rgba(214, 40, 40, 0.850)')
    expect(heatColor(-1)).toBe(heatColor(0))
    expect(heatColor(3)).toBe(heatColor(1))
  })
})

describe('renderHeatmap', () => {
  it('draws hot roads, bottleneck borders and blocked-junction markers without touching the monitor', () => {
    const graph = RoadGraph.fromLayout({
      nodes: [
        { id: 0, x: 0, y: 0 },
        { id: 1, x: 4, y: 0 },
        { id: 2, x: 8, y: 0 },
      ],
      segments: [
        { from: 0, to: 1 },
        { from: 1, to: 2 },
      ],
    })
    let time = 0
    const fleet = [1, 2, 3, 4].map((id) => ({
      id, kind: 'car', origin: 0, destination: 2, steps: [{ edge: 0, from: 0, to: 1 }], stepIndex: 0,
      progress: 0, speed: 0, state: 'waiting', waitTime: 0, waitingFor: 10, spawnedAt: 0,
    }))
    const sim = {
      minGap: 1,
      vehicles: () => fleet,
      stats: () => ({ time }),
      laneOccupants: () => fleet,
    } as unknown as TrafficSim
    const monitor = new NetworkMonitor(graph, sim)
    for (let i = 0; i < 20 * 15; i++) {
      time += 0.05
      monitor.observe(0.05)
    }
    const before = JSON.stringify(monitor.roads())
    const { ctx, calls } = recordingContext()
    renderHeatmap(ctx, graph, monitor, fitViewport(10, 4, 500, 200))
    expect(JSON.stringify(monitor.roads())).toBe(before)
    const strokes = calls.filter((c) => c.name === 'stroke').map((c) => c.stroke)
    expect(strokes).toContain('#ffffff') // dashed bottleneck border (+ the × marker)
    expect(strokes).toContain(heatColor(monitor.heatOf(0)))
    expect(strokes).toContain('#e0402f') // blocked junction ring at node 1
    expect(calls.some((c) => c.name === 'arc')).toBe(true)
  })
})
