import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import GameHud from '@app/components/GameHud.vue'
import { snap } from './fixtures'

describe('GameHud', () => {
  it('shows level, time, cars and congestion from the snapshot', () => {
    const w = mount(GameHud, { props: { snapshot: snap() } })
    expect(w.find('[data-testid="hud-level"]').text()).toBe('2')
    expect(w.find('[data-testid="hud-time"]').text()).toBe('1:15 / 3:00')
    expect(w.find('[data-testid="hud-cars"]').text()).toBe('17')
    expect(w.find('[data-testid="hud-congestion-text"]').text()).toBe('13% · Flowing')
    const meter = w.find('[role="meter"]')
    expect(meter.attributes('aria-valuenow')).toBe('13')
    expect(meter.attributes('aria-valuetext')).toBe('13%, Flowing')
  })

  it.each([
    ['normal', 10, 'Flowing'],
    ['warning', 62, 'Warning'],
    ['critical', 91, 'Critical'],
  ] as const)('labels %s congestion in text, not just colour', (level, value, label) => {
    const w = mount(GameHud, { props: { snapshot: snap({ congestion: value, congestionLevel: level }) } })
    expect(w.find('[data-testid="hud-congestion"]').attributes('data-level')).toBe(level)
    expect(w.find('[data-testid="hud-congestion-text"]').text()).toBe(`${value}% · ${label}`)
  })

  it('emits pause while running and resume while paused', async () => {
    const running = mount(GameHud, { props: { snapshot: snap() } })
    await running.find('[data-testid="hud-pause"]').trigger('click')
    expect(running.emitted('pause')).toHaveLength(1)

    const paused = mount(GameHud, { props: { snapshot: snap({ state: 'paused' }) } })
    const button = paused.find('[data-testid="hud-pause"]')
    expect(button.text()).toContain('Resume')
    expect(button.attributes('aria-pressed')).toBe('true')
    await button.trigger('click')
    expect(paused.emitted('resume')).toHaveLength(1)
  })

  it('disables pause when the level is over', () => {
    for (const state of ['gameOver', 'levelComplete', 'ready'] as const) {
      const w = mount(GameHud, { props: { snapshot: snap({ state }) } })
      expect(w.find('[data-testid="hud-pause"]').attributes('disabled')).toBeDefined()
    }
  })
})
