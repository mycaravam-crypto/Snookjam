/**
 * Public entry point for framework-independent game logic.
 * Nothing under src/game may import from Vue or src/app. Rendering code in
 * src/game/render draws through an injected Canvas 2D context.
 */
export * from './config'
export * from './roads'
export * from './world'
export * from './render'
