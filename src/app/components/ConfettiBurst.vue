<script setup lang="ts">
/** Decorative confetti for the level-complete screen. Pure CSS animation. */
const COLORS = ['#ffcf3f', '#7ed957', '#3ea7ff', '#ff5a3c', '#ff8ad8', '#ffffff']
const COUNT = 48

// Fixed per mount: each piece gets a random lane, colour, size, delay and spin.
const pieces = Array.from({ length: COUNT }, (_, i) => ({
  id: i,
  style: {
    left: `${Math.random() * 100}%`,
    background: COLORS[i % COLORS.length],
    width: `${6 + Math.random() * 6}px`,
    height: `${10 + Math.random() * 8}px`,
    borderRadius: i % 3 === 0 ? '50%' : '2px',
    animationDelay: `${Math.random() * 0.6}s`,
    animationDuration: `${2.2 + Math.random() * 1.6}s`,
    '--drift': `${(Math.random() - 0.5) * 160}px`,
    '--spin': `${(Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 720)}deg`,
  },
}))
</script>

<template>
  <div class="confetti" aria-hidden="true" data-testid="confetti">
    <span v-for="p in pieces" :key="p.id" class="confetti-piece" :style="p.style" />
  </div>
</template>
