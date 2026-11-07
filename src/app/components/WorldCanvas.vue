<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  clientToWorld,
  FONT_FAMILY,
  fitViewport,
  renderConstructionPreview,
  renderRoundabouts,
  renderSignals,
  renderVehicles,
  renderWorld,
  worldToScreen,
  snapToRoad,
  type ConstructionController,
  type ConstructionFeedback,
  type ConstructionOutcome,
  type NodeId,
  type Point,
  type TrafficSim,
  type Viewport,
  type World,
} from '@game/index'

const props = withDefaults(
  defineProps<{
    world: World
    construction?: ConstructionController
    /** Traffic to draw on top of the map. */
    traffic?: TrafficSim
    /** Whether pointer input may build roads. */
    interactive?: boolean
    /** 'road' drags build roads; 'signal' / 'roundabout' taps place or select junction upgrades. */
    tool?: 'road' | 'signal' | 'roundabout'
    /** Node of the selected traffic lights, if any. */
    selectedSignal?: NodeId
    /** Node of the selected roundabout, if any. */
    selectedRoundabout?: NodeId
  }>(),
  { construction: undefined, traffic: undefined, interactive: true, tool: 'road', selectedSignal: undefined, selectedRoundabout: undefined },
)
const emit = defineEmits<{ outcome: [ConstructionOutcome]; tap: [Point] }>()

/** A tap may wander this far (CSS px) and still count as a tap. */
const TAP_SLOP = 12

const FEEDBACK_MS = 700
/** Rotate the map only when that makes it at least this much larger. */
const ROTATE_THRESHOLD = 1.15

const canvas = ref<HTMLCanvasElement | null>(null)
let viewport: Viewport | undefined
let observer: ResizeObserver | undefined
let frame = 0
let activePointer: number | undefined
let tapStart: { id: number; x: number; y: number; point: Point } | undefined
let feedback: ConstructionFeedback | undefined
let feedbackTimer: ReturnType<typeof setTimeout> | undefined
let unsubscribe: (() => void) | undefined
let background: HTMLCanvasElement | undefined
let backgroundWorld: World | undefined
let backgroundKey = ''

/** Current world↔screen mapping in CSS pixels. */
function getViewport(): Viewport | undefined {
  return viewport
}
/** Page client coordinates of a world point (accounts for rotation); for tests. */
function worldToClient(point: Point): Point | undefined {
  const el = canvas.value
  if (!el || !viewport) return undefined
  const rect = el.getBoundingClientRect()
  const p = worldToScreen(viewport, point)
  return { x: rect.left + p.x, y: rect.top + p.y }
}
defineExpose({ getViewport, draw, worldToClient })

function draw(): void {
  frame = 0
  const el = canvas.value
  if (!el) return
  const width = el.clientWidth
  const height = el.clientHeight
  if (width === 0 || height === 0) return
  // On tall (portrait) canvases, turn the map a quarter so it fills the space.
  viewport = fitViewport(props.world.width, props.world.height, width, height, 8, {
    rotateIfLargerBy: ROTATE_THRESHOLD,
  })
  const dpr = window.devicePixelRatio || 1
  const pixelW = Math.round(width * dpr)
  const pixelH = Math.round(height * dpr)
  if (el.width !== pixelW || el.height !== pixelH) {
    el.width = pixelW
    el.height = pixelH
  }
  const ctx = el.getContext('2d')
  if (!ctx) return
  // The map and built roads change rarely: render them once into a cached
  // layer and copy it each frame, then draw the moving parts on top.
  const roads = props.construction?.builtRoads.length ?? 0
  const key = `${pixelW}x${pixelH}@${dpr}#${roads}`
  if (!background || backgroundWorld !== props.world || backgroundKey !== key) {
    background = background ?? document.createElement('canvas')
    background.width = pixelW
    background.height = pixelH
    const bg = background.getContext('2d')
    if (bg) {
      bg.setTransform(dpr, 0, 0, dpr, 0, 0)
      renderWorld(bg, props.world, viewport, {
        additionalRoads: props.construction?.builtRoads.map((road) => road.points) ?? [],
      })
    }
    backgroundWorld = props.world
    backgroundKey = key
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(background, 0, 0)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  if (props.construction) renderConstructionPreview(ctx, props.construction.preview, feedback, viewport)
  if (props.traffic) {
    renderRoundabouts(ctx, props.traffic, viewport, {
      selected: props.selectedRoundabout,
      showCandidates: props.tool === 'roundabout' && props.interactive,
    })
    renderVehicles(ctx, props.traffic, viewport)
    renderSignals(ctx, props.traffic, viewport, { selected: props.selectedSignal, showCandidates: props.tool === 'signal' && props.interactive })
  }
}

function scheduleDraw(): void {
  if (frame) return
  frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(draw) : 0
  if (!frame) draw()
}

function toWorld(e: Pick<PointerEvent, 'clientX' | 'clientY'>): Point | undefined {
  const el = canvas.value
  if (!el || !viewport) return undefined
  return clientToWorld(viewport, el.getBoundingClientRect(), e.clientX, e.clientY)
}

function onPointerDown(e: PointerEvent): void {
  if (props.tool !== 'road') {
    if (!props.interactive || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
    const point = toWorld(e)
    if (!point) return
    e.preventDefault()
    tapStart = { id: e.pointerId, x: e.clientX, y: e.clientY, point }
    return
  }
  const c = props.construction
  if (!c || !props.interactive || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
  const point = toWorld(e)
  if (!point || !c.pointerDown(point)) return
  e.preventDefault()
  activePointer = e.pointerId
  canvas.value?.setPointerCapture?.(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (props.tool !== 'road') {
    if (tapStart?.id === e.pointerId) e.preventDefault()
    return
  }
  const c = props.construction
  const point = toWorld(e)
  if (!c || !point) return
  if (activePointer === e.pointerId) {
    e.preventDefault()
    // Coalesced events carry the full trajectory between frames (#18).
    const trace = (e.getCoalescedEvents?.() ?? []).map(toWorld).filter((p): p is Point => p !== undefined)
    c.pointerMove(trace.length > 0 ? trace : point)
  } else if (e.pointerType === 'mouse' && canvas.value && props.interactive) {
    // Hint that a drag can start here.
    canvas.value.style.cursor = snapToRoad(c.graph, point, c.options) ? 'crosshair' : 'default'
  }
}

function onPointerUp(e: PointerEvent): void {
  if (props.tool !== 'road') {
    const start = tapStart
    tapStart = undefined
    if (!start || start.id !== e.pointerId) return
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) <= TAP_SLOP) emit('tap', start.point)
    return
  }
  const c = props.construction
  if (!c || activePointer !== e.pointerId) return
  activePointer = undefined
  const point = toWorld(e)
  const outcome = point ? c.pointerUp(point) : (c.cancel(), { kind: 'none' as const })
  if (outcome.kind === 'committed') showFeedback({ kind: 'committed', from: outcome.road.from, to: outcome.road.to, points: outcome.road.points })
  else if (outcome.kind === 'rejected') showFeedback({ kind: 'rejected', from: outcome.from, to: outcome.to, points: outcome.path })
  emit('outcome', outcome)
}

function onPointerCancel(e: PointerEvent): void {
  if (tapStart?.id === e.pointerId) tapStart = undefined
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
  // Town labels are cached in the background layer; repaint it once the
  // display font is ready so they don't stay in the fallback font.
  document.fonts?.load(`600 16px ${FONT_FAMILY}`).then(
    () => {
      backgroundKey = ''
      scheduleDraw()
    },
    () => {},
  )
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
  () => props.interactive,
  (interactive) => {
    if (interactive || activePointer === undefined) return
    activePointer = undefined
    props.construction?.cancel()
    if (canvas.value) canvas.value.style.cursor = 'default'
  },
)
watch(
  () => [props.tool, props.selectedSignal, props.selectedRoundabout] as const,
  () => {
    tapStart = undefined
    if (canvas.value) canvas.value.style.cursor = props.tool !== 'road' ? 'pointer' : 'default'
    scheduleDraw()
  },
)
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
    :aria-label="tool === 'signal' ? `Map of seed ${world.seed}. Tap a junction to add or edit traffic lights.` : tool === 'roundabout' ? `Map of seed ${world.seed}. Tap a junction to build or edit a roundabout.` : `Map of seed ${world.seed}. Drag from a road and release on open terrain or another road to build.`"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @lostpointercapture="onPointerCancel"
    @contextmenu.prevent
  />
</template>
