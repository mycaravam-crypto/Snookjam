import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import App from '@app/App.vue'

afterEach(() => window.history.replaceState(null, '', '/'))

async function play() {
  const wrapper = mount(App, { attachTo: document.body })
  await wrapper.find('[data-testid="play"]').trigger('click')
  await flushPromises()
  return wrapper
}

describe('App entry point', () => {
  it('renders the start screen with instructions', () => {
    const wrapper = mount(App)
    expect(wrapper.find('h1').text()).toBe('Snookjam')
    expect(wrapper.find('.how-to').text()).toContain('Drag from one road to another')
    expect(wrapper.find('[data-testid="play"]').exists()).toBe(true)
  })

  it('starts a running game with HUD and map after pressing Play', async () => {
    const wrapper = await play()
    expect(wrapper.find('[data-testid="game-shell"]').exists()).toBe(true)
    expect(wrapper.find('canvas').exists()).toBe(true)
    expect(wrapper.find('[data-testid="hud-level"]').text()).toBe('1')
    expect(wrapper.find('[data-testid="hud-pause"]').text()).toContain('Pause')
    expect(wrapper.find('[data-testid="build-status"]').text()).toContain('Drag from a road')
    wrapper.unmount()
  })

  it('pauses, offers overlay actions, and quits to the title screen', async () => {
    const wrapper = await play()
    await wrapper.find('[data-testid="hud-pause"]').trigger('click')
    expect(wrapper.find('[data-testid="overlay"]').attributes('data-state')).toBe('paused')
    expect(wrapper.find('[data-testid="hud-pause"]').text()).toContain('Resume')
    await wrapper.find('[data-testid="overlay-resume"]').trigger('click')
    expect(wrapper.find('[data-testid="overlay"]').exists()).toBe(false)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }))
    await flushPromises()
    expect(wrapper.find('[data-testid="overlay"]').exists()).toBe(true)
    await wrapper.find('[data-testid="overlay-quit"]').trigger('click')
    expect(wrapper.find('h1').text()).toBe('Snookjam')
    wrapper.unmount()
  })

  it('uses the ?seed= URL parameter for the map', async () => {
    window.history.replaceState(null, '', '/?seed=4242')
    const wrapper = await play()
    expect(wrapper.find('canvas').attributes('aria-label')).toContain('4242')
    wrapper.unmount()
  })
})
