/**
 * Client-side save slot (#36) on top of a Web Storage object
 * (localStorage by default). Every storage call is guarded: storage can be
 * missing, blocked (private browsing, disabled site data) or full, and each
 * of those becomes a SaveError with a player-facing message rather than an
 * exception from the browser.
 */
import { parseSave, SaveError, serializeSave, type SaveData } from './format'

export const SAVE_KEY = 'snookjam.save'

/** The subset of the Web Storage API the slot uses. */
export type SaveStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export class SaveSlot {
  constructor(
    private readonly storage: () => SaveStorage | undefined = defaultStorage,
    readonly key = SAVE_KEY,
  ) {}

  /** Writes the save; throws SaveError ('storage-unavailable' | 'storage-full'). */
  write(data: SaveData): void {
    const store = this.open()
    const text = serializeSave(data)
    try {
      store.setItem(this.key, text)
    } catch (e) {
      if (isQuotaError(e)) throw new SaveError('storage-full', 'browser storage is full')
      throw new SaveError('storage-unavailable', 'browser storage rejected the save')
    }
  }

  /** Reads and validates the save; throws SaveError ('not-found' and the format errors). */
  read(): SaveData {
    const text = this.readText()
    if (text === null) throw new SaveError('not-found', 'no saved game')
    return parseSave(text)
  }

  /** Whether a save is stored (without validating it). False if storage is unavailable. */
  exists(): boolean {
    try {
      return this.readText() !== null
    } catch {
      return false
    }
  }

  clear(): void {
    try {
      this.storage()?.removeItem(this.key)
    } catch {
      // Nothing to clear if storage is blocked.
    }
  }

  private readText(): string | null {
    const store = this.open()
    try {
      return store.getItem(this.key)
    } catch {
      throw new SaveError('storage-unavailable', 'browser storage could not be read')
    }
  }

  private open(): SaveStorage {
    let store: SaveStorage | undefined
    try {
      store = this.storage()
    } catch {
      store = undefined
    }
    if (!store) throw new SaveError('storage-unavailable', 'browser storage is unavailable')
    return store
  }
}

function defaultStorage(): SaveStorage | undefined {
  // Accessing localStorage itself throws when site data is blocked.
  return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage
}

function isQuotaError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const { name, code } = e as { name?: string; code?: number }
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22 || code === 1014
}
