<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { DEFAULT_CONFIG, generateWorld } from '@game/index'
import { initialSeed, randomSeed } from '../seed'
import WorldCanvas from './WorldCanvas.vue'

defineEmits<{ quit: [] }>()

const config = DEFAULT_CONFIG
const seed = shallowRef<number | string>(initialSeed())
const world = computed(() =>
  generateWorld(seed.value, { width: config.mapWidth, height: config.mapHeight }),
)

function newMap(): void {
  seed.value = randomSeed()
}
</script>

<template>
  <div class="shell" data-testid="game-shell">
    <header class="hud">
      <span>Level 1</span>
      <span data-testid="seed">Seed {{ world.seed }}</span>
      <button type="button" data-testid="new-map" @click="newMap">New map</button>
      <button type="button" class="back" @click="$emit('quit')">Back</button>
    </header>
    <WorldCanvas :world="world" />
  </div>
</template>
