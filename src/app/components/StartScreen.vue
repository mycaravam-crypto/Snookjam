<script setup lang="ts">
import { ref } from 'vue'
import type { GameMode, WorldTheme } from '@game/index'

const emit = defineEmits<{ play: [mode: GameMode, theme: WorldTheme] }>()
const theme = ref<WorldTheme>('countryside')
function play(mode: GameMode): void { emit('play', mode, theme.value) }
</script>

<template>
  <section class="start" aria-labelledby="title">
    <div class="logo" aria-hidden="true">
      <span class="logo-car logo-car--a" />
      <span class="logo-car logo-car--b" />
    </div>
    <h1 id="title">Snookjam</h1>
    <p class="tagline">Build roads. Beat the gridlock.</p>
    <ol class="how-to" aria-label="How to play">
      <li>Cars arrive through the <strong>tunnels</strong> at the map edges and drive between them.</li>
      <li>Busy junctions back up. <strong>Drag from one road to another</strong> to build a new connection.</li>
      <li>Keep the <strong>congestion meter</strong> below 100% for 3 minutes to clear a level.</li>
    </ol>
    <div class="themes" role="group" aria-label="World environment">
      <button type="button" data-testid="theme-countryside" :aria-pressed="theme === 'countryside'" @click="theme = 'countryside'"><strong>Countryside</strong><span>Fields & forests</span></button>
      <button type="button" data-testid="theme-city" :aria-pressed="theme === 'city'" @click="theme = 'city'"><strong>City</strong><span>Urban blocks</span></button>
      <button type="button" data-testid="theme-desert" :aria-pressed="theme === 'desert'" @click="theme = 'desert'"><strong>Desert</strong><span>Sand & oases</span></button>
    </div>
    <button type="button" class="play" data-testid="play" @click="play('classic')">Play</button>
    <div class="modes" role="group" aria-label="Other modes">
      <button type="button" data-testid="play-objectives" @click="play('objectives')">
        <strong>Objectives</strong>
        <span>Meet each level's goals for points</span>
      </button>
      <button type="button" data-testid="play-sandbox" @click="play('sandbox')">
        <strong>Sandbox</strong>
        <span>No timer, no gridlock: just build</span>
      </button>
    </div>
    <p class="keys">Mouse or touch. Press <kbd>P</kbd> or <kbd>Esc</kbd> to pause.</p>
  </section>
</template>
