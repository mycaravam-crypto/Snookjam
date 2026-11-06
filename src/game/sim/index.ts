/**
 * Traffic simulation (#5). Framework-independent: no Vue, DOM or Canvas.
 *
 *   const sim = new TrafficSim(graph, { portals, random: createRng(seed) })
 *   const clock = new FixedStepClock(config.simulationHz)
 *   // each animation frame:
 *   for (let i = clock.advance(elapsedSec); i > 0; i--) sim.step(clock.stepSec)
 */
export * from './clock'
export * from './traffic'
export * from './lanes'
export * from './vehicleClasses'
