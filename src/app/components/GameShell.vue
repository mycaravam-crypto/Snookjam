<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { REJECTION_MESSAGES, SIGNAL_GREEN_OPTIONS, shopItems, type ConstructionOutcome, type EditResult, type GameMode, type Point, type ShopItemId } from '@game/index'
import { canBuild, createGameController, type SignalTapResult, type Tool } from '../game/gameController'
import { initialSeed, randomSeed } from '../seed'
import GameHud from './GameHud.vue'
import GameOverlay from './GameOverlay.vue'
import NetworkPanel from './NetworkPanel.vue'
import WorldCanvas from './WorldCanvas.vue'

const props = withDefaults(defineProps<{ mode?: GameMode }>(), { mode: 'classic' })
const emit = defineEmits<{ quit: [] }>()

const game = createGameController(initialSeed(), props.mode)
const { snapshot, construction, session, tool, selectedSignal, selectedRoundabout, selectedRoad } = game
const canvas = ref<InstanceType<typeof WorldCanvas> | null>(null)

const world = computed(() => {
  // Re-read on every snapshot: restart()/nextLevel() replace the world.
  void snapshot.value
  return session.value.world
})
const sim = computed(() => {
  void snapshot.value
  return session.value.sim
})
const diagnostics = computed(() => {
  void snapshot.value
  return session.value.diagnostics
})
const interactive = computed(() => canBuild(snapshot.value.state))

/** Shop (coins → junction upgrades), opened from the toolbar. */
const shopOpen = ref(false)
const items = computed(() => shopItems(session.value.economy))
const shopVisible = computed(() => shopOpen.value && interactive.value)

function buy(item: ShopItemId): void {
  const name = items.value.find((i) => i.id === item)!.name
  lastSignalMessage = game.buy(item) ? `Bought ${name.toLowerCase()}` : `Not enough coins for ${name.toLowerCase()}`
  refreshStatus()
}

// Diagnostics are display-only toggles (#34): they never pause or alter the sim.
const heatmap = ref(false)
const showStats = ref(false)

const HINT = 'Draw from any road. Connect to another road or release on open ground to create a dead end.'
const SIGNAL_HINT = 'Tap a junction to add traffic lights.'
const ROUNDABOUT_HINT = 'Tap a junction to build a roundabout.'
const REMOVE_HINT = 'Tap a road you built to remove it.'

const SAVE_KEY = 'snookjam.save.v1'
const hasSave = ref(false)

function refreshSaveAvailability(): void {
  try {
    hasSave.value = localStorage.getItem(SAVE_KEY) !== null
  } catch {
    hasSave.value = false
  }
}

function saveGame(): void {
  try {
    const payload = JSON.stringify(game.saveData())
    localStorage.setItem(SAVE_KEY, payload)
    hasSave.value = true
    status.value = 'Game saved on this device'
  } catch (error) {
    status.value = error instanceof DOMException && error.name === 'QuotaExceededError'
      ? 'Save failed: browser storage is full'
      : 'Save failed: browser storage is unavailable'
  }
}

function loadGame(): void {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) {
      hasSave.value = false
      status.value = 'No saved game on this device'
      return
    }
    game.loadSave(JSON.parse(raw))
    status.value = 'Game loaded · paused'
    lastOutcome = ''
    lastSignalMessage = ''
    lastEditMessage = ''
    shopOpen.value = false
    heatmap.value = false
    showStats.value = false
  } catch (error) {
    status.value = error instanceof Error ? `Load failed: ${error.message}` : 'Load failed: invalid save'
  }
}

/** Player roads to draw, re-read on every snapshot (#33). */
const roads = computed(() => {
  void snapshot.value
  return session.value.roads()
})
const roadsVersion = computed(() => {
  void snapshot.value
  return session.value.roadsVersion
})
const canUndo = computed(() => {
  void snapshot.value
  return interactive.value && session.value.canUndo
})
const canRedo = computed(() => {
  void snapshot.value
  return interactive.value && session.value.canRedo
})
/** Whether the selected road has vehicles on it (removing it closes it first). */
const selectedBusy = computed(() => {
  void snapshot.value
  const id = selectedRoad.value
  return id !== undefined && session.value.isRoadOccupied(id)
})
let lastEditMessage = ''

const EDIT_MESSAGES: Record<string, string> = {
  built: 'Road rebuilt',
  removed: 'Road removed',
  closing: 'Road closed: it goes once the cars on it have left',
  reopened: 'Road reopened',
}

function describeEdit(result: EditResult | undefined, verb: 'Undo' | 'Redo' | 'Remove'): string {
  if (!result) return ''
  if (result.ok) return verb === 'Remove' ? EDIT_MESSAGES[result.action]! : `${verb}: ${EDIT_MESSAGES[result.action]!.toLowerCase()}`
  if (result.reason === 'nothing-to-undo') return 'Nothing to undo'
  if (result.reason === 'nothing-to-redo') return 'Nothing to redo'
  return `${verb} failed: nothing was changed`
}

function undo(): void {
  lastEditMessage = describeEdit(game.undo(), 'Undo')
  showEditMessage()
}

function redo(): void {
  lastEditMessage = describeEdit(game.redo(), 'Redo')
  showEditMessage()
}

function removeRoad(): void {
  lastEditMessage = describeEdit(game.removeSelectedRoad(), 'Remove')
  showEditMessage()
}

/** Edit messages replace whatever the current tool would say until the next action. */
function showEditMessage(): void {
  lastOutcome = tool.value === 'road' ? lastEditMessage : lastOutcome
  lastSignalMessage = tool.value === 'signal' || tool.value === 'roundabout' ? lastEditMessage : lastSignalMessage
  refreshStatus()
}
const status = ref(HINT)
let lastOutcome = ''
let lastSignalMessage = ''

/** The selected traffic lights, re-read on every snapshot (#32). */
const signal = computed(() => {
  void snapshot.value
  const node = selectedSignal.value
  return node === undefined ? undefined : session.value.sim.signalAt(node)
})

/** Keep a panel on the other half of the screen from what it edits. */
function sideAwayFrom(point: Point | undefined): 'top' | 'bottom' {
  const at = point && canvas.value?.worldToClient(point)
  if (!at || typeof window === 'undefined') return 'top'
  return at.y < window.innerHeight / 2 ? 'bottom' : 'top'
}
const panelSide = computed(() => sideAwayFrom(signal.value?.junction.center))
const roadPanelSide = computed(() => {
  const road = roads.value.find((r) => r.id === selectedRoad.value)
  if (!road) return 'top'
  const first = road.points[0]!
  const last = road.points[road.points.length - 1]!
  return sideAwayFrom({ x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 })
})

function chooseTool(next: Tool): void {
  game.setTool(next)
  lastSignalMessage = ''
  lastEditMessage = ''
  refreshStatus()
}

const TAP_MESSAGES: Record<'signal' | 'roundabout', Record<SignalTapResult, string>> = {
  signal: {
    placed: 'Traffic lights added',
    selected: 'Editing traffic lights',
    none: 'No junction there: tap where three or more roads meet',
    unavailable: '',
    unowned: 'No traffic lights left: buy some in the shop',
    occupied: 'That junction has a roundabout',
  },
  roundabout: {
    placed: 'Roundabout built',
    selected: 'Editing roundabout',
    none: 'No junction there: tap where three or more roads meet',
    unavailable: '',
    unowned: 'No roundabouts left: buy one in the shop',
    occupied: 'That junction has traffic lights: remove them first',
  },
}

function onTap(point: Point): void {
  if (tool.value === 'road') return
  if (tool.value === 'remove') {
    const result = game.tapRoad(point)
    lastEditMessage =
      result === 'selected'
        ? selectedRoad.value === undefined
          ? 'That road is already closing'
          : 'Road selected'
        : result === 'generated'
          ? 'Only roads you built can be removed'
          : result === 'none'
            ? REMOVE_HINT
            : ''
    refreshStatus()
    return
  }
  shopOpen.value = false // keep the junction panel clear
  const result = tool.value === 'signal' ? game.tapSignal(point) : game.tapRoundabout(point)
  lastSignalMessage = TAP_MESSAGES[tool.value][result]
  refreshStatus()
}

function removeRoundabout(): void {
  game.removeSelectedRoundabout()
  lastSignalMessage = 'Roundabout removed'
  refreshStatus()
}

function removeSignal(): void {
  game.removeSelectedSignal()
  lastSignalMessage = 'Traffic lights removed'
  refreshStatus()
}

function refreshStatus(): void {
  if (tool.value === 'remove') {
    status.value = lastEditMessage || REMOVE_HINT
    return
  }
  if (tool.value === 'signal' || tool.value === 'roundabout') {
    status.value = lastSignalMessage || (tool.value === 'signal' ? SIGNAL_HINT : ROUNDABOUT_HINT)
    return
  }
  const preview = construction.value.preview
  if (preview) status.value = preview.check.ok ? 'Release to build' : `Can't build: ${REJECTION_MESSAGES[preview.check.reason]}`
  else status.value = lastOutcome || HINT
}

function onOutcome(outcome: ConstructionOutcome): void {
  if (outcome.kind === 'committed') lastOutcome = 'Road built'
  else if (outcome.kind === 'rejected') lastOutcome = `Not built: ${REJECTION_MESSAGES[outcome.reason]}`
  refreshStatus()
}

// Frame loop: advance the simulation by real time, then redraw.
let raf = 0
let last: number | undefined
function loop(now: number): void {
  const dt = last === undefined ? 0 : Math.min(0.25, (now - last) / 1000)
  last = now
  game.frame(dt)
  canvas.value?.draw()
  raf = requestAnimationFrame(loop)
}

function onKey(e: KeyboardEvent): void {
  // Undo / redo (#33): Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
    e.preventDefault()
    if (e.key === 'y' || e.key === 'Y' || e.shiftKey) redo()
    else undo()
    return
  }
  if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
    e.preventDefault()
    game.togglePause()
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'h' || e.key === 'H')) {
    heatmap.value = !heatmap.value
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'i' || e.key === 'I')) {
    showStats.value = !showStats.value
  }
}

function onVisibility(): void {
  if (document.hidden) game.pause()
}

let unwatchConstruction: (() => void) | undefined
function watchConstruction(): void {
  unwatchConstruction?.()
  lastOutcome = ''
  unwatchConstruction = construction.value.onChange(refreshStatus)
  refreshStatus()
}

onMounted(() => {
  game.start()
  refreshSaveAvailability()
  watchConstruction()
  window.addEventListener('keydown', onKey)
  document.addEventListener('visibilitychange', onVisibility)
  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(loop)
})
onBeforeUnmount(() => {
  if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('visibilitychange', onVisibility)
  unwatchConstruction?.()
  game.dispose()
})

// A new level or game brings a new construction controller.
watch(construction, watchConstruction)

defineExpose({ game })

// Test hook for browser tests (#9): always in dev, and in production only with ?test in the URL.
if (import.meta.env.DEV || new URLSearchParams(window.location.search).has('test')) {
  ;(window as unknown as { __snookjam?: unknown }).__snookjam = {
    ...game,
    /** Client coordinates of a world point on the current canvas (handles map rotation). */
    worldToClient: (point: { x: number; y: number }) => canvas.value?.worldToClient(point),
  }
}
</script>

<template>
  <div class="shell" data-testid="game-shell">
    <GameHud
      :snapshot="snapshot"
      :heatmap="heatmap"
      :stats="showStats"
      @pause="game.pause()"
      @resume="game.resume()"
      @toggle-heatmap="heatmap = !heatmap"
      @toggle-stats="showStats = !showStats"
    />
    <div class="stage">
      <WorldCanvas
        ref="canvas"
        :world="world"
        :construction="construction"
        :traffic="sim"
        :interactive="interactive"
        :diagnostics="diagnostics"
        :heatmap="heatmap"
        :tool="tool"
        :selected-signal="selectedSignal"
        :selected-roundabout="selectedRoundabout"
        :roads="roads"
        :roads-version="roadsVersion"
        :selected-road="selectedRoad"
        @outcome="onOutcome"
        @tap="onTap"
      />
      <NetworkPanel v-if="showStats" :stats="snapshot.network" :heatmap="heatmap" @close="showStats = false" />
      <div v-if="interactive" class="tools" role="toolbar" aria-label="Build tools">
        <button
          type="button"
          data-testid="tool-road"
          :aria-pressed="tool === 'road'"
          @click="chooseTool('road')"
        >
          Road
        </button>
        <button
          type="button"
          data-testid="tool-signal"
          :aria-pressed="tool === 'signal'"
          @click="chooseTool('signal')"
        >
          Lights <span class="tool-count" data-testid="owned-signal">×{{ snapshot.inventory.signal }}</span>
        </button>
        <button
          type="button"
          data-testid="tool-roundabout"
          :aria-pressed="tool === 'roundabout'"
          @click="chooseTool('roundabout')"
        >
          Roundabout <span class="tool-count" data-testid="owned-roundabout">×{{ snapshot.inventory.roundabout }}</span>
        </button>
        <button
          type="button"
          data-testid="tool-remove"
          :aria-pressed="tool === 'remove'"
          @click="chooseTool('remove')"
        >
          Remove
        </button>
        <span class="tools-gap" aria-hidden="true" />
        <button type="button" data-testid="save-game" @click="saveGame">Save</button>
        <button type="button" data-testid="load-game" :disabled="!hasSave" @click="loadGame">Load</button>
        <button
          type="button"
          class="tool-icon"
          data-testid="undo"
          :disabled="!canUndo"
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
          @click="undo"
        >
          <span aria-hidden="true">↶</span>
        </button>
        <button
          type="button"
          class="tool-icon"
          data-testid="redo"
          :disabled="!canRedo"
          aria-label="Redo"
          title="Redo (Ctrl+Shift+Z)"
          @click="redo"
        >
          <span aria-hidden="true">↷</span>
        </button>
        <span class="tools-gap" aria-hidden="true" />
        <button
          type="button"
          class="tool-shop"
          data-testid="tool-shop"
          :aria-pressed="shopOpen"
          :aria-expanded="shopOpen"
          @click="shopOpen = !shopOpen"
        >
          Shop <span class="coin" aria-hidden="true">●</span> {{ snapshot.coins }}
        </button>
      </div>
      <section v-if="shopVisible" class="shop-panel" data-testid="shop-panel" aria-label="Shop">
        <header>
          <h2>Shop</h2>
          <span class="shop-coins" data-testid="shop-coins"><span class="coin" aria-hidden="true">●</span> {{ snapshot.coins }} coins</span>
          <button type="button" class="shop-close" aria-label="Close shop" data-testid="shop-close" @click="shopOpen = false">✕</button>
        </header>
        <p class="shop-hint">Earn coins for every car that gets through and a bonus for each level you finish.</p>
        <ul>
          <li v-for="item in items" :key="item.id" :data-testid="`shop-item-${item.id}`">
            <div class="shop-item-text">
              <strong>{{ item.name }}</strong>
              <span>{{ item.description }}</span>
              <span class="shop-owned">Owned {{ snapshot.inventory[item.id] }} · on map {{ snapshot.placed[item.id] }}</span>
            </div>
            <button
              type="button"
              class="shop-buy"
              :data-testid="`shop-buy-${item.id}`"
              :disabled="snapshot.coins < item.price"
              @click="buy(item.id)"
            >
              Buy <span class="coin" aria-hidden="true">●</span> {{ item.price }}
            </button>
          </li>
        </ul>
      </section>
      <section
        v-if="interactive && tool === 'remove' && selectedRoad !== undefined"
        class="signal-panel"
        :data-side="roadPanelSide"
        data-testid="road-panel"
        aria-label="Selected road"
      >
        <h2>Your road</h2>
        <p class="signal-phase" data-testid="road-panel-note">
          {{ selectedBusy ? 'Cars are on it: it closes now and goes once they have left.' : 'Nobody is on it: it goes at once.' }}
        </p>
        <button type="button" class="signal-remove" data-testid="road-remove" @click="removeRoad">Remove road</button>
      </section>
      <section
        v-if="interactive && tool === 'signal' && signal"
        class="signal-panel"
        :data-side="panelSide"
        data-testid="signal-panel"
        aria-label="Traffic lights"
      >
        <h2>Traffic lights</h2>
        <p class="signal-phase" data-testid="signal-phase">
          Phase {{ signal.phase + 1 }} of {{ signal.phases.length }} ·
          {{ signal.clearance ? 'all red' : 'green' }} {{ Math.ceil(signal.remaining) }} s
        </p>
        <div class="signal-greens" role="group" aria-label="Green time">
          <button
            v-for="sec in SIGNAL_GREEN_OPTIONS"
            :key="sec"
            type="button"
            :data-testid="`signal-green-${sec}`"
            :aria-pressed="signal.greenSec === sec"
            @click="game.setSignalGreen(sec)"
          >
            {{ sec }} s
          </button>
        </div>
        <button type="button" class="signal-remove" data-testid="signal-remove" @click="removeSignal">Remove</button>
      </section>
      <section
        v-if="interactive && tool === 'roundabout' && selectedRoundabout !== undefined"
        class="signal-panel"
        data-side="top"
        data-testid="roundabout-panel"
        aria-label="Roundabout"
      >
        <h2>Roundabout</h2>
        <p class="signal-phase">Traffic gives way and merges. Remove it to get it back.</p>
        <button type="button" class="signal-remove" data-testid="roundabout-remove" @click="removeRoundabout">Remove</button>
      </section>
      <p v-if="interactive" class="status" data-testid="build-status" role="status" aria-live="polite">{{ status }}</p>
      <GameOverlay
        :snapshot="snapshot"
        @resume="game.resume()"
        @restart="game.restart()"
        @next-level="game.nextLevel()"
        @new-map="game.newGame(randomSeed())"
        @quit="emit('quit')"
      />
    </div>
  </div>
</template>
