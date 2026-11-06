import { describe, expect, it } from 'vitest'
import { canBuild, createGameController } from '@app/game/gameController'

describe('createGameController', () => {
  it('forwards lifecycle actions and refreshes the snapshot', () => {
    const game = createGameController(7)
    expect(game.snapshot.value.state).toBe('ready')
    game.start()
    expect(game.snapshot.value.state).toBe('running')
    game.togglePause()
    expect(game.snapshot.value.state).toBe('paused')
    game.togglePause()
    expect(game.snapshot.value.state).toBe('running')
    game.dispose()
  })

  it('advances time only while running', () => {
    const game = createGameController(7)
    game.start()
    game.frame(1)
    const t = game.snapshot.value.levelTime
    expect(t).toBeGreaterThan(0)
    game.pause()
    game.frame(1)
    expect(game.snapshot.value.levelTime).toBe(t)
    game.dispose()
  })

  it('builds roads through the session and recreates the builder on restart', () => {
    const game = createGameController(7)
    game.start()
    const first = game.construction.value
    expect(first.world).toBe(game.session.value.world)
    expect(first.graph).toBe(game.session.value.graph)
    game.restart()
    expect(game.construction.value).not.toBe(first)
    expect(game.construction.value.graph).toBe(game.session.value.graph)
    game.dispose()
  })

  it('moves to the next level with a new builder', () => {
    const game = createGameController(7)
    game.start()
    const session = game.session.value
    while (session.state === 'running') session.tick()
    game.frame(0)
    if (game.snapshot.value.state !== 'levelComplete') return // lost level 1: covered elsewhere
    const before = game.construction.value
    game.nextLevel()
    expect(game.snapshot.value.level).toBe(2)
    expect(game.construction.value).not.toBe(before)
    expect(game.construction.value.world).toBe(game.session.value.world)
    game.dispose()
  })

  it('starts a new game with a new seed', () => {
    const game = createGameController(7)
    game.start()
    game.newGame(8)
    expect(game.session.value.seed).toBe(8)
    expect(game.snapshot.value.state).toBe('running')
    expect(game.construction.value.world).toBe(game.session.value.world)
    game.dispose()
  })

  it('allows building only while running or paused', () => {
    expect(canBuild('running')).toBe(true)
    expect(canBuild('paused')).toBe(true)
    expect(canBuild('ready')).toBe(false)
    expect(canBuild('levelComplete')).toBe(false)
    expect(canBuild('gameOver')).toBe(false)
  })
})
