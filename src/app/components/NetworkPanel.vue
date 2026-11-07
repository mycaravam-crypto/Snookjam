<script setup lang="ts">
import { computed } from 'vue'
import type { NetworkStats } from '@game/index'

const props = defineProps<{ stats: NetworkStats; heatmap: boolean }>()
defineEmits<{ close: [] }>()

const DASH = '—'

function seconds(value: number | undefined): string {
  return value === undefined ? DASH : `${value < 10 ? value.toFixed(1) : Math.round(value)} s`
}

const rows = computed(() => {
  const s = props.stats
  return [
    { id: 'journeys', label: 'Journeys done', value: String(s.completedJourneys), hint: 'Cars that reached their destination tunnel this level' },
    { id: 'throughput', label: 'Throughput', value: s.throughputPerMin === undefined ? DASH : `${s.throughputPerMin.toFixed(1)}/min`, hint: 'Journeys completed per minute, last 60 s' },
    { id: 'travel', label: 'Avg trip', value: seconds(s.averageTravelSec), hint: 'Mean time from entering to leaving the map' },
    { id: 'wait', label: 'Avg wait', value: seconds(s.averageWaitSec), hint: 'Mean time a finished trip spent standing still' },
    { id: 'active', label: 'On the map', value: String(s.activeVehicles), hint: 'Vehicles currently driving or queued' },
    { id: 'waiting', label: 'Waiting now', value: String(s.waitingVehicles), hint: 'Vehicles that did not move in the last step' },
    { id: 'bottlenecks', label: 'Bottlenecks', value: String(s.bottlenecks), hint: 'Roads queued at least half full for 8 s or more' },
    { id: 'blocked', label: 'Blocked junctions', value: String(s.blockedJunctions), hint: 'Junctions whose front car has not moved for 2 s' },
  ]
})
</script>

<template>
  <section class="network" data-testid="network-panel" aria-label="Traffic statistics">
    <header class="network-head">
      <h2>Traffic</h2>
      <button type="button" class="network-close" aria-label="Close traffic statistics" @click="$emit('close')">×</button>
    </header>
    <dl class="network-stats">
      <div v-for="row in rows" :key="row.id" :title="row.hint" :data-alert="(row.id === 'bottlenecks' || row.id === 'blocked') && row.value !== '0' ? '' : undefined">
        <dt>{{ row.label }}</dt>
        <dd :data-testid="`network-${row.id}`">{{ row.value }}</dd>
      </div>
    </dl>
    <p v-if="heatmap" class="network-legend" data-testid="network-legend">
      <span class="legend-scale" aria-hidden="true" />
      <span>Queue: light → full</span>
      <span class="legend-key"><span class="legend-dash" aria-hidden="true" /> bottleneck</span>
      <span class="legend-key"><span class="legend-ring" aria-hidden="true">×</span> blocked</span>
    </p>
  </section>
</template>
