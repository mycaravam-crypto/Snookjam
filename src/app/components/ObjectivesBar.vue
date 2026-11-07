<script setup lang="ts">
import type { ObjectiveProgress } from '@game/index'
import { objectiveGoal, objectiveValue, STATUS_ICONS } from '../objectives'

defineProps<{ objectives: readonly ObjectiveProgress[] }>()
</script>

<template>
  <ul class="objectives" data-testid="objectives" aria-label="Level objectives">
    <li
      v-for="(o, i) in objectives"
      :key="i"
      class="objective"
      :data-status="o.status"
      :data-on-track="o.onTrack"
      :data-testid="`objective-${o.kind}`"
    >
      <span class="objective-goal">
        <span v-if="STATUS_ICONS[o.status]" class="objective-icon" aria-hidden="true">{{ STATUS_ICONS[o.status] }}</span>
        {{ objectiveGoal(o.kind, o.target) }}
      </span>
      <span class="objective-value" :data-testid="`objective-${o.kind}-value`">{{ objectiveValue(o) }}</span>
      <span class="objective-track" aria-hidden="true"><span :style="{ width: `${Math.round(o.progress * 100)}%` }" /></span>
      <span class="visually-hidden">{{ o.status === 'met' ? 'met' : o.status === 'failed' ? 'missed' : o.onTrack ? 'on track' : 'not yet met' }}</span>
    </li>
  </ul>
</template>
