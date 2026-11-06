/** Seed from `?seed=` in the URL, or a fresh random seed. */
export function initialSeed(search: string = window.location.search): number | string {
  const fromUrl = new URLSearchParams(search).get('seed')
  if (fromUrl) return /^\d+$/.test(fromUrl) ? Number(fromUrl) : fromUrl
  return randomSeed()
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32)
}
