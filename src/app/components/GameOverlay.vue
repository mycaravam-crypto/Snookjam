<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { SessionSnapshot } from '@game/index'
import { formatTime } from '../format'

const props = defineProps<{ snapshot: SessionSnapshot }>()
defineEmits<{ resume: []; restart: []; nextLevel: []; newMap: []; quit: [] }>()

const visible = computed(() => ['paused', 'levelComplete', 'gameOver'].includes(props.snapshot.state))
const card = ref<HTMLElement | null>(null)

// Move focus into the dialog when it opens so keyboard users can act on it.
watch(
  () => props.snapshot.state,
  async () => {
    if (!visible.value) return
    await nextTick()
    card.value?.querySelector<HTMLButtonElement>('button')?.focus()
  },
  { immediate: true },
)
</script>

<template>
  <div v-if="visible" class="overlay" data-testid="overlay" :data-state="snapshot.state">
    <section ref="card" class="overlay-card" role="dialog" aria-modal="true" aria-labelledby="overlay-title">
      <template v-if="snapshot.state === 'paused'">
        <div class="overlay-badge" aria-hidden="true">❚❚</div>
        <h2 id="overlay-title">Paused</h2>
        <p>Traffic is frozen. You can still build roads while paused.</p>
        <div class="overlay-actions">
          <button type="button" class="primary" data-testid="overlay-resume" @click="$emit('resume')">Resume</button>
          <button type="button" data-testid="overlay-restart" @click="$emit('restart')">Restart level 1</button>
          <button type="button" data-testid="overlay-new-map" @click="$emit('newMap')">New map</button>
          <button type="button" data-testid="overlay-quit" @click="$emit('quit')">Quit to title</button>
        </div>
      </template>

      <template v-else-if="snapshot.state === 'levelComplete'">
        <div class="overlay-badge" aria-hidden="true">★</div>
        <h2 id="overlay-title">Level {{ snapshot.level }} complete</h2>
        <p>
          You kept traffic moving for {{ formatTime(snapshot.levelTime) }}.
          {{ snapshot.vehiclesExited }} cars got through so far.
        </p>
        <p>The next level has a new map and heavier traffic.</p>
        <div class="overlay-actions">
          <button type="button" class="primary" data-testid="overlay-next" @click="$emit('nextLevel')">
            Continue to level {{ snapshot.level + 1 }}
          </button>
          <button type="button" data-testid="overlay-quit" @click="$emit('quit')">Quit to title</button>
        </div>
      </template>

      <template v-else>
        <div class="overlay-badge" aria-hidden="true">✕</div>
        <h2 id="overlay-title">Gridlock!</h2>
        <p>
          Congestion hit 100% on level {{ snapshot.level }} after {{ formatTime(snapshot.levelTime) }}.
          You survived {{ formatTime(snapshot.totalTime) }} in total and {{ snapshot.vehiclesExited }} cars got through.
        </p>
        <div class="overlay-actions">
          <button type="button" class="primary" data-testid="overlay-restart" @click="$emit('restart')">Try again</button>
          <button type="button" data-testid="overlay-new-map" @click="$emit('newMap')">New map</button>
          <button type="button" data-testid="overlay-quit" @click="$emit('quit')">Quit to title</button>
        </div>
      </template>
      <p class="overlay-seed">Map seed {{ snapshot.seed }}</p>
    </section>
  </div>
</template>
