import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '@app/App.vue'

describe('App entry point', () => {
  it('renders the start screen', () => {
    const wrapper = mount(App)
    expect(wrapper.find('h1').text()).toBe('Snookjam')
    expect(wrapper.find('[data-testid="play"]').exists()).toBe(true)
  })

  it('shows the game shell after pressing Play and returns on Back', async () => {
    const wrapper = mount(App)
    await wrapper.find('[data-testid="play"]').trigger('click')
    expect(wrapper.find('[data-testid="game-shell"]').exists()).toBe(true)
    expect(wrapper.find('canvas').exists()).toBe(true)

    await wrapper.find('.hud .back').trigger('click')
    expect(wrapper.find('[data-testid="game-shell"]').exists()).toBe(false)
  })
})

describe('game shell world', () => {
  it('generates the map from the ?seed= URL parameter', async () => {
    window.history.replaceState(null, '', '/?seed=4242')
    const wrapper = mount(App)
    await wrapper.find('[data-testid="play"]').trigger('click')
    expect(wrapper.find('[data-testid="seed"]').text()).toBe('Seed 4242')
    expect(wrapper.find('canvas').attributes('aria-label')).toContain('4242')
    window.history.replaceState(null, '', '/')
  })
})
