import type { Rng } from './rng'

/**
 * Fractal value noise sampled onto a width × height grid, in [0, 1].
 * Each octave draws a lattice from the rng, so the result is seed-determined.
 */
export function fractalNoise(
  rng: Rng,
  width: number,
  height: number,
  baseCell: number,
  octaves = 3,
): Float32Array {
  const out = new Float32Array(width * height)
  let amplitude = 1
  let total = 0
  let cell = baseCell
  for (let o = 0; o < octaves; o++) {
    const lw = Math.ceil(width / cell) + 2
    const lh = Math.ceil(height / cell) + 2
    const lattice = new Float32Array(lw * lh)
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next()
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const fx = x / cell
        const fy = y / cell
        const x0 = Math.floor(fx)
        const y0 = Math.floor(fy)
        const sx = smooth(fx - x0)
        const sy = smooth(fy - y0)
        const v00 = lattice[y0 * lw + x0]!
        const v10 = lattice[y0 * lw + x0 + 1]!
        const v01 = lattice[(y0 + 1) * lw + x0]!
        const v11 = lattice[(y0 + 1) * lw + x0 + 1]!
        const top = v00 + (v10 - v00) * sx
        const bottom = v01 + (v11 - v01) * sx
        out[y * width + x]! += (top + (bottom - top) * sy) * amplitude
      }
    }
    total += amplitude
    amplitude *= 0.5
    cell = Math.max(1, cell / 2)
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / total
  return out
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}
