<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  clientToWorld,
  fitViewport,
  renderBuiltRoads,
  renderConstructionPreview,
  renderWorld,
  snapToRoad,
  type ConstructionController,
  type ConstructionFeedback,
  type ConstructionOutcome,
  type Point,
  type Viewport,
  type World,
} from '@game/index'

const props = defineProps<{ world: World; construction?: ConstructionController }>()
const emit = defineEmits<{ outcome: [ConstructionOutcome] }>()

const FEEDBACK_MS = 700

const canvas = ref<HTMLCanvasElement | null>(null)
let viewport: Viewport | undefined
let observer: ResizeObserver | undefined
let frame = 0
let activePointer: number | undefined
let feedback: ConstructionFeedback | undefined
let feedbackTimer: ReturnType<typeof setTimeout> | undefined
let unsubscribe: (() => void) | undefined

/** Current world↔screen mapping in CSS pixels. */
function getViewport(): Viewport | undefined {
  return viewport
}
defineExpose({ getViewport })

function draw(): void {
  frame = 0
  const el = canvas.value
  if (!el) return
  const width = el.clientWidth
  const height = el.clientHeight
  if (width === 0 || height === 0) return
  viewport = fitViewport(props.world.width, props.world.height, width, height, 8)
  const dpr = window.devicePixelRatio || 1
  const pixelW = Math.round(width * dpr)
  const pixelH = Math.round(height * dpr)
  if (el.width !== pixelW || el.height !== pixelH) {
    el.width = pixelW
    el.height = pixelH
  }
  const ctx = el.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  renderWorld(ctx, props.world, viewport)
  if (props.construction) {
    renderBuiltRoads(ctx, props.construction.builtRoads, viewport)
    renderConstructionPreview(ctx, props.construction.preview, feedback, viewport)
  }
}

function scheduleDraw(): void {
  if (frame) return
  frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(draw) : 0
  if (!frame) draw()
}

function toWorld(e: PointerEvent): Point | undefined {
  const el = canvas.value
  if (!el || !viewport) return undefined
  return clientToWorld(viewport, el.getBoundingClientRect(), e.clientX, e.clientY)
}

function onPointerDown(e: PointerEvent): void {
  const c = props.construction
  if (!c || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
  const point = toWorld(e)
  if (!point || !c.pointerDown(point)) return
  e.preventDefault()
  activePointer = e.pointerId
  canvas.value?.setPointerCapture?.(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  const c = props.construction
  const point = toWorld(e)
  if (!c || !point) return
  if (activePointer === e.pointerId) {
    e.preventDefault()
    c.pointerMove(point)
  } else if (e.pointerType === 'mouse' && canvas.value) {
    // Hint that a drag can start here.
    canvas.value.style.cursor = snapToRoad(c.graph, point, c.options) ? 'crosshair' : 'default'
  }
}

function onPointerUp(e: PointerEvent): void {
  const c = props.construction
  if (!c || activePointer !== e.pointerId) return
  activePointer = undefined
  const point = toWorld(e)
  const outcome = point ? c.pointerUp(point) : (c.cancel(), { kind: 'none' as const })
  if (outcome.kind === 'committed') showFeedback({ kind: 'committed', from: outcome.road.from, to: outcome.road.to })
  else if (outcome.kind === 'rejected') showFeedback({ kind: 'rejected', from: outcome.from, to: outcome.to })
  emit('outcome', outcome)
}

function onPointerCancel(e: PointerEvent): void {
  if (activePointer !== e.pointerId) return
  activePointer = undefined
  props.construction?.cancel()
}

function showFeedback(next: ConstructionFeedback): void {
  feedback = next
  clearTimeout(feedbackTimer)
  feedbackTimer = setTimeout(() => {
    feedback = undefined
    scheduleDraw()
  }, FEEDBACK_MS)
  scheduleDraw()
}

function subscribe(): void {
  unsubscribe?.()
  unsubscribe = props.construction?.onChange(scheduleDraw)
}

onMounted(() => {
  subscribe()
  draw()
  if (typeof ResizeObserver !== 'undefined' && canvas.value) {
    observer = new ResizeObserver(() => draw())
    observer.observe(canvas.value)
  }
})
onBeforeUnmount(() => {
  observer?.disconnect()
  unsubscribe?.()
  clearTimeout(feedbackTimer)
  if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
})
watch(
  () => [props.world, props.construction] as const,
  () => {
    activePointer = undefined
    feedback = undefined
    subscribe()
    scheduleDraw()
  },
)
</script>

<template>
  <canvas
    ref="canvas"
    class="world"
    role="img"
    :aria-label="`Map of seed ${world.seed}. Drag from a road to another road to build a connection.`"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @lostpointercapture="onPointerCancel"
    @contextmenu.prevent
  />
</template>
