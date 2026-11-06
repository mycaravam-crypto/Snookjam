<script setup lang="ts">
import { ref } from 'vue'
import GameShell from './components/GameShell.vue'

const playing = ref(false)
</script>

<template>
  <main class="app">
    <section v-if="!playing" class="start" aria-labelledby="title">
      <h1 id="title">Snookjam</h1>
      <p class="tagline">Keep the traffic flowing through the countryside.</p>
      <button type="button" class="play" data-testid="play" @click="playing = true">Play</button>
    </section>
    <GameShell v-else @quit="playing = false" />
  </main>
</template>
