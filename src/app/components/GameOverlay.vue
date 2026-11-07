<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { SessionSnapshot } from '@game/index'
import { formatTime } from '../format'
import { objectiveGoal, objectiveValue, STATUS_ICONS } from '../objectives'
import ConfettiBurst from './ConfettiBurst.vue'

const props = defineProps<{ snapshot: SessionSnapshot }>()
defineEmits<{ resume: []; restart: []; nextLevel: []; newMap: []; quit: [] }>()

const visible = computed(() => ['paused', 'levelComplete', 'gameOver'].includes(props.snapshot.state))
const scored = computed(() => props.snapshot.mode === 'objectives')
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
    <ConfettiBurst v-if="snapshot.state === 'levelComplete'" />
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
        <div class="overlay-badge overlay-badge--win" aria-hidden="true">★</div>
        <h2 id="overlay-title">Level {{ snapshot.level }} complete</h2>
        <p>
          You kept traffic moving for {{ formatTime(snapshot.levelTime) }}.
          {{ snapshot.vehiclesExited }} cars got through so far.
        </p>
        <ul v-if="snapshot.objectives.length > 0" class="overlay-objectives" data-testid="overlay-objectives">
          <li v-for="(o, i) in snapshot.objectives" :key="i" :data-status="o.status">
            <span aria-hidden="true">{{ STATUS_ICONS[o.status] }}</span> {{ objectiveGoal(o.kind, o.target) }}: {{ objectiveValue(o) }}
          </li>
        </ul>
        <p v-if="scored" data-testid="overlay-score">Level score {{ snapshot.levelScore }} · Total {{ snapshot.score }}</p>
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
        <h2 id="overlay-title">{{ snapshot.endReason === 'objectives' ? 'Objectives missed' : 'Gridlock!' }}</h2>
        <template v-if="snapshot.endReason === 'objectives'">
          <p>Time ran out on level {{ snapshot.level }} before every goal was met.</p>
          <ul class="overlay-objectives" data-testid="overlay-objectives">
            <li v-for="(o, i) in snapshot.objectives" :key="i" :data-status="o.status">
              <span aria-hidden="true">{{ STATUS_ICONS[o.status] }}</span> {{ objectiveGoal(o.kind, o.target) }}: {{ objectiveValue(o) }}
            </li>
          </ul>
        </template>
        <p v-else>
          Congestion hit 100% on level {{ snapshot.level }} after {{ formatTime(snapshot.levelTime) }}.
          You survived {{ formatTime(snapshot.totalTime) }} in total and {{ snapshot.vehiclesExited }} cars got through.
        </p>
        <p v-if="scored" data-testid="overlay-score">Final score {{ snapshot.score }}</p>
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
