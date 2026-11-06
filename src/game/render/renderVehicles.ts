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
  // The state outline is drawn inside the footprint so cars never look wider
  // than the lane allows.
  const o = Math.max(1, width * 0.18)
  ctx.fillStyle = STATE_OUTLINE[vehicle.state]
  ctx.fillRect(-length / 2, -width / 2, length, width)
  ctx.fillStyle = BODY_COLORS[vehicle.id % BODY_COLORS.length]!
  ctx.fillRect(-length / 2 + o, -width / 2 + o, length - 2 * o, width - 2 * o)
  // Windscreen marks the front.
  ctx.fillStyle = COLORS.vehicleGlass
  ctx.fillRect(length * 0.1, -width / 2 + o, length * 0.16, width - 2 * o)
  ctx.restore()
  if (vehicle.state === 'stuck') {
    ctx.fillStyle = COLORS.vehicleStuck
    ctx.font = `700 ${Math.round(Math.max(10, length * 1.2))}px ${FONT_FAMILY}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText('!', x, y - width)
  }
}
