import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import GameOverlay from '@app/components/GameOverlay.vue'
import { snap } from './fixtures'

describe('GameOverlay', () => {
  it('renders nothing while running or ready', () => {
    for (const state of ['running', 'ready'] as const) {
      expect(mount(GameOverlay, { props: { snapshot: snap({ state }) } }).find('[data-testid="overlay"]').exists()).toBe(false)
    }
  })

  it('offers resume, restart, new map and quit when paused', async () => {
    const w = mount(GameOverlay, { props: { snapshot: snap({ state: 'paused' }) } })
    expect(w.find('h2').text()).toBe('Paused')
    for (const [id, event] of [
      ['overlay-resume', 'resume'],
      ['overlay-restart', 'restart'],
      ['overlay-new-map', 'newMap'],
      ['overlay-quit', 'quit'],
    ] as const) {
      await w.find(`[data-testid="${id}"]`).trigger('click')
      expect(w.emitted(event)).toHaveLength(1)
    }
  })

  it('offers the next level after completing one', async () => {
    const w = mount(GameOverlay, { props: { snapshot: snap({ state: 'levelComplete', level: 2, levelTime: 180 }) } })
    expect(w.find('h2').text()).toBe('Level 2 complete')
    expect(w.text()).toContain('3:00')
    await w.find('[data-testid="overlay-next"]').trigger('click')
    expect(w.emitted('nextLevel')).toHaveLength(1)
    expect(w.find('[data-testid="overlay-next"]').text()).toContain('level 3')
  })

  it('celebrates a completed level with confetti only', () => {
    const won = mount(GameOverlay, { props: { snapshot: snap({ state: 'levelComplete' }) } })
    const confetti = won.find('[data-testid="confetti"]')
    expect(confetti.exists()).toBe(true)
    expect(confetti.attributes('aria-hidden')).toBe('true')
    for (const state of ['paused', 'gameOver'] as const) {
      expect(mount(GameOverlay, { props: { snapshot: snap({ state }) } }).find('[data-testid="confetti"]').exists()).toBe(false)
    }
  })

  it('reports the run and offers a restart on game over', async () => {
    const w = mount(GameOverlay, {
      props: { snapshot: snap({ state: 'gameOver', level: 3, levelTime: 65, totalTime: 425, congestion: 100 }) },
    })
    expect(w.find('h2').text()).toBe('Gridlock!')
    expect(w.text()).toContain('level 3 after 1:05')
    expect(w.text()).toContain('7:05 in total')
    await w.find('[data-testid="overlay-restart"]').trigger('click')
    expect(w.emitted('restart')).toHaveLength(1)
  })

  it('is an accessible modal dialog', () => {
    const w = mount(GameOverlay, { props: { snapshot: snap({ state: 'paused' }) } })
    const dialog = w.find('[role="dialog"]')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.attributes('aria-labelledby')).toBe('overlay-title')
  })
})
