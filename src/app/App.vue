<script setup lang="ts">
import { ref } from 'vue'
import type { GameMode, WorldTheme } from '@game/index'
import GameShell from './components/GameShell.vue'
import StartScreen from './components/StartScreen.vue'

const playing = ref(false)
const mode = ref<GameMode>('classic')
const theme = ref<WorldTheme>('countryside')

function play(next: GameMode, nextTheme: WorldTheme): void {
  mode.value = next
  theme.value = nextTheme
  playing.value = true
}
</script>

<template>
  <main class="app">
    <StartScreen v-if="!playing" @play="play" />
    <GameShell v-else :mode="mode" :theme="theme" @quit="playing = false" />
  </main>
</template>
