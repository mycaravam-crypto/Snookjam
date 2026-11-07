<script setup lang="ts">
import { computed } from 'vue'
import type { SessionSnapshot } from '@game/index'
import { formatTime } from '../format'

const props = withDefaults(defineProps<{ snapshot: SessionSnapshot; heatmap?: boolean; stats?: boolean }>(), {
  heatmap: false,
  stats: false,
})
defineEmits<{ pause: []; resume: []; toggleHeatmap: []; toggleStats: [] }>()

const LEVEL_LABELS = { normal: 'Flowing', warning: 'Warning', critical: 'Critical' } as const
const LEVEL_ICONS = { normal: '●', warning: '▲', critical: '‼' } as const

const percent = computed(() => Math.round(props.snapshot.congestion))
const label = computed(() => LEVEL_LABELS[props.snapshot.congestionLevel])
const icon = computed(() => LEVEL_ICONS[props.snapshot.congestionLevel])
const paused = computed(() => props.snapshot.state === 'paused')
const canPause = computed(() => props.snapshot.state === 'running' || paused.value)
</script>

<template>
  <header class="hud" data-testid="hud">
    <dl class="hud-stats">
      <div>
        <dt>Level</dt>
        <dd data-testid="hud-level">{{ snapshot.level }}</dd>
      </div>
      <div>
        <dt>Time</dt>
        <dd data-testid="hud-time">
          {{ formatTime(snapshot.levelTime) }}<span class="hud-dim"> / {{ formatTime(snapshot.levelDuration) }}</span>
        </dd>
      </div>
      <div>
        <dt>Cars</dt>
        <dd data-testid="hud-cars">{{ snapshot.activeVehicles }}</dd>
      </div>
    </dl>

    <div class="meter" :data-level="snapshot.congestionLevel" data-testid="hud-congestion">
      <div class="meter-label">
        <span>Congestion</span>
        <span class="meter-value">
          <span aria-hidden="true">{{ icon }}</span>
          <span data-testid="hud-congestion-text">{{ percent }}% · {{ label }}</span>
        </span>
      </div>
      <div
        class="meter-track"
        role="meter"
        aria-label="Congestion"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="percent"
        :aria-valuetext="`${percent}%, ${label}`"
      >
        <div class="meter-fill" :style="{ width: `${percent}%` }" />
        <div class="meter-mark" style="left: 50%" aria-hidden="true" />
        <div class="meter-mark" style="left: 80%" aria-hidden="true" />
      </div>
    </div>

    <div class="hud-tools">
      <button
        type="button"
        class="hud-toggle"
        data-testid="hud-heatmap"
        title="Congestion heatmap (H)"
        :aria-pressed="heatmap"
        @click="$emit('toggleHeatmap')"
      >
        <span aria-hidden="true">▦</span> Heatmap
      </button>
      <button
        type="button"
        class="hud-toggle"
        data-testid="hud-stats"
        title="Traffic statistics (I)"
        :aria-pressed="stats"
        @click="$emit('toggleStats')"
      >
        <span aria-hidden="true">ⓘ</span> Stats
      </button>
    </div>

    <button
      type="button"
      class="hud-pause"
      data-testid="hud-pause"
      :disabled="!canPause"
      :aria-pressed="paused"
      @click="paused ? $emit('resume') : $emit('pause')"
    >
      <span aria-hidden="true">{{ paused ? '▶' : '❚❚' }}</span>
      {{ paused ? 'Resume' : 'Pause' }}
    </button>
  </header>
</template>
