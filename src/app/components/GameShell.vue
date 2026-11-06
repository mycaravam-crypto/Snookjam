<script setup lang="ts">
import { DEFAULT_CONFIG } from '@game/index'

defineEmits<{ quit: [] }>()

const config = DEFAULT_CONFIG
</script>

<template>
  <div class="shell" data-testid="game-shell">
    <header class="hud">
      <span>Level 1</span>
      <span>Map {{ config.mapWidth }} × {{ config.mapHeight }}</span>
      <button type="button" @click="$emit('quit')">Back</button>
    </header>
    <!-- The Canvas 2D world renderer is added in #3. -->
    <canvas class="world" aria-label="Game world" />
  </div>
</template>
