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

    await wrapper.find('.hud button').trigger('click')
    expect(wrapper.find('[data-testid="game-shell"]').exists()).toBe(false)
  })
})
