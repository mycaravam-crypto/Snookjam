<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fitViewport, renderWorld, type Viewport, type World } from '@game/index'

const props = defineProps<{ world: World }>()

const canvas = ref<HTMLCanvasElement | null>(null)
let viewport: Viewport | undefined
let observer: ResizeObserver | undefined

/** Current world↔screen mapping in CSS pixels (used by input handling later). */
function getViewport(): Viewport | undefined {
  return viewport
}
defineExpose({ getViewport })

function draw(): void {
  const el = canvas.value
  if (!el) return
  const width = el.clientWidth
  const height = el.clientHeight
  if (width === 0 || height === 0) return
  const dpr = window.devicePixelRatio || 1
  el.width = Math.round(width * dpr)
  el.height = Math.round(height * dpr)
  const ctx = el.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  viewport = fitViewport(props.world.width, props.world.height, width, height, 8)
  renderWorld(ctx, props.world, viewport)
}

onMounted(() => {
  draw()
  if (typeof ResizeObserver !== 'undefined' && canvas.value) {
    observer = new ResizeObserver(() => draw())
    observer.observe(canvas.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())
watch(() => props.world, draw)
</script>

<template>
  <canvas ref="canvas" class="world" role="img" :aria-label="`Map of seed ${world.seed}`" />
</template>
