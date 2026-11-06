import { ROAD_GEOMETRY } from '../sim/lanes'
import type { TrafficSim, Vehicle, VehicleState } from '../sim/traffic'
import { screenAngle, worldToScreen, type Viewport } from '../world/viewport'
import type { RenderContext } from './renderWorld'
import { COLORS, FONT_FAMILY } from './palette'

export type VehicleContext = RenderContext & Pick<CanvasRenderingContext2D, 'translate' | 'rotate'>

const BODY_COLORS = ['#2f6fd6', '#f2f2f2', '#2b2b2b', '#c7362b', '#e0a32a', '#3d9a5b', '#8a4fc2']

/** Outline colour by state; queued cars also get a marker above them. */
const STATE_OUTLINE: Record<VehicleState, string> = {
  moving: COLORS.vehicleOutline,
  waiting: COLORS.vehicleWaiting,
  stuck: COLORS.vehicleStuck,
}

/**
 * Draws vehicles as small cars in their lanes, at the position and size the
 * simulation uses (sim.lanePositionOf, ROAD_GEOMETRY), oriented along their
 * heading. Waiting cars get
 * an amber outline and stuck cars a red outline plus a "!" marker, so queue
 * state does not rely on colour alone. Reads the sim; never mutates it.
 */
export function renderVehicles(ctx: VehicleContext, sim: TrafficSim, v: Viewport): void {
  const s = v.scale
  // Drawn at their simulated size so the gap between lanes stays visible.
  const length = s * ROAD_GEOMETRY.vehicleLength
  const width = s * ROAD_GEOMETRY.vehicleWidth
  ctx.save()
  for (const vehicle of sim.vehicles()) {
    const { position, heading } = sim.lanePositionOf(vehicle)
    const p = worldToScreen(v, position)
    drawCar(ctx, vehicle, p.x, p.y, screenAngle(v, heading), length, width)
  }
  ctx.restore()
}

/** Drop-shadow offset in screen pixels (down-right, matching the map). */
const SHADOW = 1.5

function drawCar(
  ctx: VehicleContext,
  vehicle: Vehicle,
  x: number,
  y: number,
  heading: number,
  length: number,
  width: number,
): void {
  const hl = length / 2
  const hw = width / 2
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(heading)
  // Shadow: a fixed screen offset expressed in the car's rotated frame.
  const sx = SHADOW * (Math.cos(heading) + Math.sin(heading))
  const sy = SHADOW * (Math.cos(heading) - Math.sin(heading))
  ctx.fillStyle = COLORS.vehicleShadow
  ctx.fillRect(-hl + sx, -hw + sy, length, width)
  // The state outline is drawn inside the footprint so cars never look wider
  // than the lane allows.
  const o = Math.max(1, width * 0.18)
  ctx.fillStyle = STATE_OUTLINE[vehicle.state]
  ctx.fillRect(-hl, -hw, length, width)
  ctx.fillStyle = BODY_COLORS[vehicle.id % BODY_COLORS.length]!
  ctx.fillRect(-hl + o, -hw + o, length - 2 * o, width - 2 * o)
  // Cabin roof, windscreen (front) and rear window.
  ctx.fillStyle = COLORS.vehicleRoof
  ctx.fillRect(-length * 0.22, -hw + o, length * 0.36, width - 2 * o)
  ctx.fillStyle = COLORS.vehicleGlass
  ctx.fillRect(length * 0.1, -hw + o, length * 0.16, width - 2 * o)
  ctx.fillRect(-length * 0.34, -hw + o, length * 0.1, width - 2 * o)
  if (length >= 8) {
    // Headlights.
    const lw = Math.max(1, width * 0.22)
    ctx.fillStyle = COLORS.vehicleLight
    ctx.fillRect(hl - 1, -hw, 1, lw)
    ctx.fillRect(hl - 1, hw - lw, 1, lw)
  }
  ctx.restore()
  if (vehicle.state === 'stuck') {
    // A red badge with "!" above the car.
    const r = Math.max(6, length * 0.6)
    const by = y - width - r
    ctx.fillStyle = COLORS.vehicleStuck
    ctx.beginPath()
    ctx.arc(x, by, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = `700 ${Math.round(r * 1.5)}px ${FONT_FAMILY}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('!', x, by + r * 0.08)
  }
}
