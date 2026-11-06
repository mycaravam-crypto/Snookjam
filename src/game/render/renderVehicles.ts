import type { TrafficSim, Vehicle, VehicleState } from '../sim/traffic'
import { worldToScreen, type Viewport } from '../world/viewport'
import type { RenderContext } from './renderWorld'
import { COLORS } from './palette'

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
    drawCar(ctx, vehicle, p.x, p.y, heading, length, width)
  }
  ctx.restore()
}

function drawCar(
  ctx: VehicleContext,
  vehicle: Vehicle,
  x: number,
  y: number,
  heading: number,
  length: number,
  width: number,
): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(heading)
  ctx.fillStyle = STATE_OUTLINE[vehicle.state]
  ctx.fillRect(-length / 2 - 1, -width / 2 - 1, length + 2, width + 2)
  ctx.fillStyle = BODY_COLORS[vehicle.id % BODY_COLORS.length]!
  ctx.fillRect(-length / 2, -width / 2, length, width)
  // Windscreen marks the front.
  ctx.fillStyle = COLORS.vehicleGlass
  ctx.fillRect(length * 0.12, -width / 2 + 1, length * 0.18, width - 2)
  ctx.restore()
  if (vehicle.state === 'stuck') {
    ctx.fillStyle = COLORS.vehicleStuck
    ctx.font = `700 ${Math.round(Math.max(10, length * 1.2))}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText('!', x, y - width)
  }
}
