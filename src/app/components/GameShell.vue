<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { REJECTION_MESSAGES, type ConstructionOutcome } from '@game/index'
import { canBuild, createGameController } from '../game/gameController'
import { initialSeed, randomSeed } from '../seed'
import GameHud from './GameHud.vue'
import GameOverlay from './GameOverlay.vue'
import NetworkPanel from './NetworkPanel.vue'
import WorldCanvas from './WorldCanvas.vue'

const emit = defineEmits<{ quit: [] }>()

const game = createGameController(initialSeed())
const { snapshot, construction, session } = game
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

// Diagnostics are display-only toggles (#34): they never pause or alter the sim.
const heatmap = ref(false)
const showStats = ref(false)

const HINT = 'Drag from a road to another road to build a connection.'
const status = ref(HINT)
let lastOutcome = ''

function refreshStatus(): void {
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
        @outcome="onOutcome"
      />
      <NetworkPanel v-if="showStats" :stats="snapshot.network" :heatmap="heatmap" @close="showStats = false" />
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
