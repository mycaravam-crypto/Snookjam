<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import {
  ConstructionController,
  createRoadGraph,
  DEFAULT_CONFIG,
  generateWorld,
  REJECTION_MESSAGES,
  type ConstructionOutcome,
} from '@game/index'
import { initialSeed, randomSeed } from '../seed'
import WorldCanvas from './WorldCanvas.vue'

defineEmits<{ quit: [] }>()

const config = DEFAULT_CONFIG
const seed = shallowRef<number | string>(initialSeed())
const world = computed(() =>
  generateWorld(seed.value, { width: config.mapWidth, height: config.mapHeight }),
)
const construction = computed(() => new ConstructionController(world.value, createRoadGraph(world.value)))

const HINT = 'Drag from a road to another road to build a connection.'
const status = ref(HINT)
const builtCount = ref(0)
let lastOutcome = ''

function refreshStatus(): void {
  const c = construction.value
  const preview = c.preview
  builtCount.value = c.builtRoads.length
  if (preview) status.value = preview.check.ok ? 'Release to build' : `Can't build: ${REJECTION_MESSAGES[preview.check.reason]}`
  else status.value = lastOutcome || HINT
}

let unsubscribe: (() => void) | undefined
watch(
  construction,
  (c) => {
    unsubscribe?.()
    lastOutcome = ''
    unsubscribe = c.onChange(refreshStatus)
    refreshStatus()
  },
  { immediate: true },
)
onBeforeUnmount(() => unsubscribe?.())

function onOutcome(outcome: ConstructionOutcome): void {
  if (outcome.kind === 'committed') lastOutcome = 'Road built'
  else if (outcome.kind === 'rejected') lastOutcome = `Not built: ${REJECTION_MESSAGES[outcome.reason]}`
  refreshStatus()
}

function newMap(): void {
  seed.value = randomSeed()
}
</script>

<template>
  <div class="shell" data-testid="game-shell">
    <header class="hud">
      <span>Level 1</span>
      <span data-testid="seed">Seed {{ world.seed }}</span>
      <span data-testid="built">Roads built {{ builtCount }}</span>
      <button type="button" data-testid="new-map" @click="newMap">New map</button>
      <button type="button" class="back" @click="$emit('quit')">Back</button>
    </header>
    <div class="stage">
      <WorldCanvas :world="world" :construction="construction" @outcome="onOutcome" />
      <!-- Overlaid so status changes never resize the canvas mid-gesture. -->
      <p class="status" data-testid="build-status" role="status" aria-live="polite">{{ status }}</p>
    </div>
  </div>
</template>
