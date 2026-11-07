<script setup lang="ts">
import { ref } from 'vue'
import type { GameMode } from '@game/index'
import GameShell from './components/GameShell.vue'
import StartScreen from './components/StartScreen.vue'

const playing = ref(false)
const mode = ref<GameMode>('classic')

function play(next: GameMode): void {
  mode.value = next
  playing.value = true
}
</script>

<template>
  <main class="app">
    <StartScreen v-if="!playing" @play="play" />
    <GameShell v-else :mode="mode" @quit="playing = false" />
  </main>
</template>
