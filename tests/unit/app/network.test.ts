import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import GameHud from '@app/components/GameHud.vue'
import NetworkPanel from '@app/components/NetworkPanel.vue'
import { EMPTY_NETWORK_STATS, type NetworkStats } from '@game/index'
import { snap } from './fixtures'

const stats = (overrides: Partial<NetworkStats> = {}): NetworkStats => ({ ...EMPTY_NETWORK_STATS, ...overrides })

describe('HUD diagnostics toggles', () => {
  it('emits toggle events and reflects pressed state', async () => {
    const w = mount(GameHud, { props: { snapshot: snap(), heatmap: true, stats: false } })
    expect(w.find('[data-testid="hud-heatmap"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="hud-stats"]').attributes('aria-pressed')).toBe('false')
    await w.find('[data-testid="hud-heatmap"]').trigger('click')
    await w.find('[data-testid="hud-stats"]').trigger('click')
    expect(w.emitted('toggleHeatmap')).toHaveLength(1)
    expect(w.emitted('toggleStats')).toHaveLength(1)
  })
})

describe('NetworkPanel', () => {
  it('shows dashes rather than misleading numbers before any journey completes', () => {
    const w = mount(NetworkPanel, { props: { stats: stats(), heatmap: false } })
    expect(w.find('[data-testid="network-journeys"]').text()).toBe('0')
    expect(w.find('[data-testid="network-throughput"]').text()).toBe('—')
    expect(w.find('[data-testid="network-travel"]').text()).toBe('—')
    expect(w.find('[data-testid="network-wait"]').text()).toBe('—')
    expect(w.find('[data-testid="network-legend"]').exists()).toBe(false)
  })

  it('formats metrics and shows the legend with the heatmap', async () => {
    const w = mount(NetworkPanel, {
      props: {
        stats: stats({ completedJourneys: 12, throughputPerMin: 7.25, averageTravelSec: 23.6, averageWaitSec: 4.04, activeVehicles: 9, waitingVehicles: 3, bottlenecks: 2, blockedJunctions: 1 }),
        heatmap: true,
      },
    })
    expect(w.find('[data-testid="network-journeys"]').text()).toBe('12')
    expect(w.find('[data-testid="network-throughput"]').text()).toBe('7.3/min')
    expect(w.find('[data-testid="network-travel"]').text()).toBe('24 s')
    expect(w.find('[data-testid="network-wait"]').text()).toBe('4.0 s')
    expect(w.find('[data-testid="network-bottlenecks"]').text()).toBe('2')
    expect(w.find('[data-testid="network-blocked"]').text()).toBe('1')
    expect(w.find('[data-testid="network-legend"]').exists()).toBe(true)
    await w.find('.network-close').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})
