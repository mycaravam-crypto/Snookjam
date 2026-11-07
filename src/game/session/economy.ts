/**
 * Score, coins and the shop.
 *
 * Success earns both: every vehicle that reaches its tunnel scores points and
 * pays coins, and finishing a level pays a bonus that grows with the level
 * and with how calm the roads were (low congestion at the end). Score only
 * goes up; coins are spent in the shop on junction upgrades. Bought items go
 * into an inventory: placing one uses it, removing it gives it back, and
 * items still on the map return to the inventory when the next level loads a
 * new map. Pure functions over plain data, so the session stays testable.
 */

export type ShopItemId = 'signal' | 'roundabout'

export interface ShopItem {
  readonly id: ShopItemId
  readonly name: string
  readonly description: string
  readonly price: number
}

export interface EconomyConfig {
  /** Coins the run starts with. */
  readonly startingCoins: number
  /** Coins per vehicle that leaves the map. */
  readonly coinsPerExit: number
  /** Score per vehicle that leaves the map. */
  readonly pointsPerExit: number
  /** Level-complete coins: base + perLevel × level, plus up to calmBonus at 0% congestion. */
  readonly levelBonusCoins: number
  readonly levelBonusCoinsPerLevel: number
  readonly calmBonusCoins: number
  /** Score per coin of level bonus. */
  readonly pointsPerBonusCoin: number
  readonly signalPrice: number
  readonly roundaboutPrice: number
}

export const DEFAULT_ECONOMY: EconomyConfig = Object.freeze({
  startingCoins: 20,
  coinsPerExit: 1,
  pointsPerExit: 10,
  levelBonusCoins: 15,
  levelBonusCoinsPerLevel: 5,
  calmBonusCoins: 20,
  pointsPerBonusCoin: 10,
  signalPrice: 15,
  roundaboutPrice: 40,
})

export function createEconomy(overrides: Partial<EconomyConfig> = {}): EconomyConfig {
  const e = { ...DEFAULT_ECONOMY, ...overrides }
  for (const [key, value] of Object.entries(e)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError(`${key} must be a non-negative number`)
  }
  return Object.freeze(e)
}

export function shopItems(economy: EconomyConfig): readonly ShopItem[] {
  return [
    {
      id: 'signal',
      name: 'Traffic lights',
      description: 'Fixed-time lights for a junction. Opposite roads share a green.',
      price: economy.signalPrice,
    },
    {
      id: 'roundabout',
      name: 'Roundabout',
      description: 'Traffic gives way and merges, so a busy junction clears much faster.',
      price: economy.roundaboutPrice,
    },
  ]
}

export function priceOf(economy: EconomyConfig, item: ShopItemId): number {
  return item === 'signal' ? economy.signalPrice : economy.roundaboutPrice
}

export interface Reward {
  readonly coins: number
  readonly points: number
}

/** Reward for `exited` vehicles reaching their tunnel. */
export function exitReward(economy: EconomyConfig, exited: number): Reward {
  return { coins: exited * economy.coinsPerExit, points: exited * economy.pointsPerExit }
}

/** Reward for completing `level` with `congestion` (0–100) on the meter. */
export function levelReward(economy: EconomyConfig, level: number, congestion: number, limit = 100): Reward {
  const calm = 1 - Math.min(1, Math.max(0, congestion / limit))
  const coins = Math.round(economy.levelBonusCoins + economy.levelBonusCoinsPerLevel * level + economy.calmBonusCoins * calm)
  return { coins, points: coins * economy.pointsPerBonusCoin }
}

export type Inventory = Readonly<Record<ShopItemId, number>>

export const EMPTY_INVENTORY: Inventory = Object.freeze({ signal: 0, roundabout: 0 })
