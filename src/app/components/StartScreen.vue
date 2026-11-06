<script setup lang="ts">
defineEmits<{ play: [] }>()
</script>

<template>
  <section class="start" aria-labelledby="title">
    <div class="logo" aria-hidden="true">
      <span class="logo-car logo-car--a" />
      <span class="logo-car logo-car--b" />
    </div>
    <h1 id="title">Snookjam</h1>
    <p class="tagline">Keep the traffic flowing through the countryside.</p>
    <ol class="how-to" aria-label="How to play">
      <li>Cars arrive through the <strong>tunnels</strong> at the map edges and drive between them.</li>
      <li>Busy junctions back up. <strong>Drag from one road to another</strong> to build a new connection.</li>
      <li>Keep the <strong>congestion meter</strong> below 100% for 3 minutes to clear a level.</li>
    </ol>
    <button type="button" class="play" data-testid="play" @click="$emit('play')">Play</button>
    <p class="keys">Mouse or touch. Press <kbd>P</kbd> or <kbd>Esc</kbd> to pause.</p>
  </section>
</template>
