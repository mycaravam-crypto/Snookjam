/**
 * Coins and the shop.
 *
 * Score is #35's (objectives.ts); coins are the spendable value earned from
 * the same successes: every vehicle that reaches its tunnel pays coins, and
 * finishing a level pays a bonus that grows with the level, with each
 * objective met and with how calm the roads were (low congestion at the
 * end). Coins are spent in the shop on junction upgrades. Bought items go
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
  /**
   * Level-complete coins: base + perLevel × level + perObjective × objectives
   * met, plus up to calmBonus at 0% congestion.
   */
  readonly levelBonusCoins: number
  readonly levelBonusCoinsPerLevel: number
  readonly coinsPerObjective: number
  readonly calmBonusCoins: number
  readonly signalPrice: number
  readonly roundaboutPrice: number
}

export const DEFAULT_ECONOMY: EconomyConfig = Object.freeze({
  startingCoins: 20,
  coinsPerExit: 1,
  levelBonusCoins: 15,
  levelBonusCoinsPerLevel: 5,
  coinsPerObjective: 10,
  calmBonusCoins: 20,
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
}

/** Reward for `exited` vehicles reaching their tunnel. */
export function exitReward(economy: EconomyConfig, exited: number): Reward {
  return { coins: exited * economy.coinsPerExit }
}

/**
 * Reward for completing `level` with `congestion` (0–100) on the meter and
 * `objectivesMet` objectives met (always all of them: missing one ends the run).
 */
export function levelReward(economy: EconomyConfig, level: number, congestion: number, limit = 100, objectivesMet = 0): Reward {
  const calm = 1 - Math.min(1, Math.max(0, congestion / limit))
  const coins = Math.round(
    economy.levelBonusCoins +
      economy.levelBonusCoinsPerLevel * level +
      economy.coinsPerObjective * objectivesMet +
      economy.calmBonusCoins * calm,
  )
  return { coins }
}

export type Inventory = Readonly<Record<ShopItemId, number>>

export const EMPTY_INVENTORY: Inventory = Object.freeze({ signal: 0, roundabout: 0 })
