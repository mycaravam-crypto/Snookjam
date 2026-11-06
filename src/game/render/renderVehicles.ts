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

/** Sideways offset so the two directions of a road use separate lanes. */
const LANE_OFFSET = 0.13

/**
 * Draws vehicles as small cars oriented along their heading. Waiting cars get
 * an amber outline and stuck cars a red outline plus a "!" marker, so queue
 * state does not rely on colour alone. Reads the sim; never mutates it.
 */
export function renderVehicles(ctx: VehicleContext, sim: TrafficSim, v: Viewport): void {
  const s = v.scale
  const length = Math.max(4, s * 0.5)
  const width = Math.max(3, s * 0.3)
  ctx.save()
  for (const vehicle of sim.vehicles()) {
    const { position, heading } = sim.positionOf(vehicle)
    // Drive on the right: shift perpendicular to the heading.
    const x = position.x - Math.sin(heading) * LANE_OFFSET
    const y = position.y + Math.cos(heading) * LANE_OFFSET
    const p = worldToScreen(v, { x, y })
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
  // Outline doubles as the queue-state indicator.
  ctx.fillStyle = STATE_OUTLINE[vehicle.state]
  ctx.fillRect(-hl - 1, -hw - 1, length + 2, width + 2)
  ctx.fillStyle = BODY_COLORS[vehicle.id % BODY_COLORS.length]!
  ctx.fillRect(-hl, -hw, length, width)
  // Cabin roof, windscreen (front) and rear window.
  ctx.fillStyle = COLORS.vehicleRoof
  ctx.fillRect(-length * 0.22, -hw + 1, length * 0.36, width - 2)
  ctx.fillStyle = COLORS.vehicleGlass
  ctx.fillRect(length * 0.14, -hw + 1, length * 0.16, width - 2)
  ctx.fillRect(-length * 0.34, -hw + 1, length * 0.1, width - 2)
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
