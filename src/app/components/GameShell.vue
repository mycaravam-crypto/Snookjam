<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { REJECTION_MESSAGES, SIGNAL_GREEN_OPTIONS, shopItems, type ConstructionOutcome, type Point, type ShopItemId } from '@game/index'
import { canBuild, createGameController, type SignalTapResult, type Tool } from '../game/gameController'
import { initialSeed, randomSeed } from '../seed'
import GameHud from './GameHud.vue'
import GameOverlay from './GameOverlay.vue'
import WorldCanvas from './WorldCanvas.vue'

const emit = defineEmits<{ quit: [] }>()

const game = createGameController(initialSeed())
const { snapshot, construction, session, tool, selectedSignal, selectedRoundabout } = game
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

const HINT = 'Drag from a road to another road to build a connection.'
const SIGNAL_HINT = 'Tap a junction to add traffic lights.'
const ROUNDABOUT_HINT = 'Tap a junction to build a roundabout.'
const status = ref(HINT)
let lastOutcome = ''
let lastSignalMessage = ''

/** The selected traffic lights, re-read on every snapshot (#32). */
const signal = computed(() => {
  void snapshot.value
  const node = selectedSignal.value
  return node === undefined ? undefined : session.value.sim.signalAt(node)
})

/** Keep the panel on the other half of the screen from the selected junction. */
const panelSide = computed(() => {
  const view = signal.value
  const at = view && canvas.value?.worldToClient(view.junction.center)
  if (!at || typeof window === 'undefined') return 'top'
  return at.y < window.innerHeight / 2 ? 'bottom' : 'top'
})

function chooseTool(next: Tool): void {
  game.setTool(next)
  lastSignalMessage = ''
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
  if (tool.value !== 'road') {
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
  if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') {
    e.preventDefault()
    game.togglePause()
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
    <GameHud :snapshot="snapshot" @pause="game.pause()" @resume="game.resume()" />
    <div class="stage">
      <WorldCanvas
        ref="canvas"
        :world="world"
        :construction="construction"
        :traffic="sim"
        :interactive="interactive"
        :tool="tool"
        :selected-signal="selectedSignal"
        :selected-roundabout="selectedRoundabout"
        @outcome="onOutcome"
        @tap="onTap"
      />
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
