/**
 * Fixed-timestep accumulator. Feed it real elapsed time (e.g. from
 * requestAnimationFrame) and it reports how many fixed simulation steps to
 * run, so simulation speed is independent of rendering frame rate.
 */
export class FixedStepClock {
  readonly stepSec: number
  /** Steps per advance() call are capped to avoid a spiral of death. */
  readonly maxStepsPerAdvance: number
  private accumulator = 0

  constructor(hz: number, maxStepsPerAdvance = 10) {
    if (!(hz > 0)) throw new RangeError('hz must be positive')
    this.stepSec = 1 / hz
    this.maxStepsPerAdvance = maxStepsPerAdvance
  }

  /** Adds real elapsed seconds; returns the number of steps to run now. */
  advance(elapsedSec: number): number {
    if (!(elapsedSec > 0)) return 0
    this.accumulator += elapsedSec
    // Small epsilon so e.g. 3 × (1/60) at 20 Hz yields exactly one step.
    let steps = Math.floor(this.accumulator / this.stepSec + 1e-9)
    if (steps > this.maxStepsPerAdvance) {
      steps = this.maxStepsPerAdvance
      this.accumulator = 0 // drop backlog after a long stall (e.g. tab hidden)
    } else {
      this.accumulator = Math.max(0, this.accumulator - steps * this.stepSec)
    }
    return steps
  }

  /** Fraction of a step accumulated, for render interpolation (0..1). */
  get alpha(): number {
    return this.accumulator / this.stepSec
  }

  reset(): void {
    this.accumulator = 0
  }
}
