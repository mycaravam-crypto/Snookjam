<script setup lang="ts">
import { ref } from 'vue'
import GameShell from './components/GameShell.vue'
import StartScreen from './components/StartScreen.vue'

const playing = ref(false)
</script>

<template>
  <main class="app">
    <StartScreen v-if="!playing" @play="playing = true" />
    <GameShell v-else @quit="playing = false" />
  </main>
</template>
