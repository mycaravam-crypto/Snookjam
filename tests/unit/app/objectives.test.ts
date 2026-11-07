import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import GameHud from '@app/components/GameHud.vue'
import GameOverlay from '@app/components/GameOverlay.vue'
import StartScreen from '@app/components/StartScreen.vue'
import type { ObjectiveProgress } from '@game/index'
import { snap } from './fixtures'

const journeys: ObjectiveProgress = { kind: 'journeys', target: 70, value: 23, progress: 23 / 70, onTrack: false, status: 'pending' }
const wait: ObjectiveProgress = { kind: 'averageWait', target: 6, value: 7.5, progress: 0.8, onTrack: false, status: 'failed' }

describe('start screen modes', () => {
  it('emits the chosen mode', async () => {
    const w = mount(StartScreen)
    await w.find('[data-testid="play"]').trigger('click')
    await w.find('[data-testid="play-objectives"]').trigger('click')
    await w.find('[data-testid="play-sandbox"]').trigger('click')
    expect(w.emitted('play')).toEqual([['classic'], ['objectives'], ['sandbox']])
  })
})

describe('HUD objectives and modes', () => {
  it('shows objective progress and the score in objectives mode', () => {
    const w = mount(GameHud, { props: { snapshot: snap({ mode: 'objectives', objectives: [journeys], score: 230 }) } })
    expect(w.find('[data-testid="hud-score"]').text()).toBe('230')
    expect(w.find('[data-testid="objective-journeys"]').text()).toContain('Complete 70 journeys')
    expect(w.find('[data-testid="objective-journeys-value"]').text()).toBe('23 / 70')
  })

  it('hides objectives and score in classic mode', () => {
    const w = mount(GameHud, { props: { snapshot: snap() } })
    expect(w.find('[data-testid="objectives"]').exists()).toBe(false)
    expect(w.find('[data-testid="hud-score"]').exists()).toBe(false)
    expect(w.find('[data-testid="hud-time"]').text()).toContain('/ 3:00')
  })

  it('shows sandbox instead of a level and no time limit', () => {
    const w = mount(GameHud, { props: { snapshot: snap({ mode: 'sandbox' }) } })
    expect(w.find('[data-testid="hud-level"]').text()).toBe('Sandbox')
    expect(w.find('[data-testid="hud-time"]').text()).not.toContain('/')
  })
})

describe('overlay results', () => {
  it('lists objective results and score when a level is complete', () => {
    const w = mount(GameOverlay, {
      props: { snapshot: snap({ state: 'levelComplete', mode: 'objectives', objectives: [{ ...journeys, value: 80, status: 'met' }], levelScore: 850, score: 1250 }) },
    })
    expect(w.find('[data-testid="overlay-objectives"]').text()).toContain('✓ Complete 70 journeys: 80 / 70')
    expect(w.find('[data-testid="overlay-score"]').text()).toBe('Level score 850 · Total 1250')
  })

  it('explains a run lost to missed objectives', () => {
    const w = mount(GameOverlay, {
      props: { snapshot: snap({ state: 'gameOver', mode: 'objectives', endReason: 'objectives', objectives: [wait], score: 600 }) },
    })
    expect(w.find('h2').text()).toBe('Objectives missed')
    expect(w.find('[data-testid="overlay-objectives"]').text()).toContain('✕ Average wait ≤ 6 s: 7.5 s')
    expect(w.find('[data-testid="overlay-score"]').text()).toBe('Final score 600')
  })

  it('keeps the gridlock message for congestion', () => {
    const w = mount(GameOverlay, { props: { snapshot: snap({ state: 'gameOver', endReason: 'congestion' }) } })
    expect(w.find('h2').text()).toBe('Gridlock!')
    expect(w.find('[data-testid="overlay-score"]').exists()).toBe(false)
  })
})
