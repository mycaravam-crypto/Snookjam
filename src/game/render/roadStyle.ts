import { roadWidth, ROAD_GEOMETRY } from '../sim/lanes'

/**
 * Road drawing widths in tiles, derived from the shared two-lane geometry
 * (#22) so generated and player-built roads look identical and always fit
 * two lanes of traffic.
 */
export const ROAD_SURFACE_WIDTH = roadWidth(ROAD_GEOMETRY)
/** Surface plus a thin verge on each side. */
export const ROAD_EDGE_WIDTH = ROAD_SURFACE_WIDTH + 0.12
/** Dashed centre line separating the two lanes. */
export const CENTRE_LINE_WIDTH = 0.04
