import type { Terrain, WorldTheme } from '../world/types'

export const TERRAIN_COLORS: Record<Terrain, string> = {
  grass: '#8fca5c',
  field: '#e3c860',
  forest: '#5c9e3f',
  water: '#4fa3e0',
  settlement: '#cdbb9a',
}

export const THEME_TERRAIN_COLORS: Record<WorldTheme, Record<Terrain, string>> = {
  countryside: TERRAIN_COLORS,
  city: {
    grass: '#aeb8bd', field: '#d5dadd', forest: '#659b62', water: '#438fbd', settlement: '#c4c8c7',
  },
  desert: {
    grass: '#d9b477', field: '#edcf8c', forest: '#8b7955', water: '#4b9bb5', settlement: '#d4b68c',
  },
}

/** Crop colours; each field tile picks one so farmland looks patchworked. */
export const FIELD_COLORS = ['#e3c860', '#dbbd55', '#d6d06a', '#e6bf5e'] as const

/** Roof colours for houses, picked per house. */
export const ROOF_COLORS = ['#c8553d', '#a8432f', '#6c7a89', '#8b5a3c'] as const
export const CITY_ROOF_COLORS = ['#526b82', '#7d8991', '#b66c4d', '#536f73'] as const
export const DESERT_ROOF_COLORS = ['#b86f45', '#d19a5c', '#9e684c', '#c4a16e'] as const

/** Font stack for canvas text; matches the UI's display font, with a system fallback. */
export const FONT_FAMILY = "Fredoka, system-ui, sans-serif"

export const COLORS = {
  background: '#14210f',
  mapShadow: '#00000080',
  mapFrame: '#0b1408',
  shadow: '#00000033',
  fieldFurrow: '#00000014',
  grassTuft: '#6fae43',
  flower: ['#ffffff', '#ffd84a', '#ff8ad8'],
  tree: '#2f7a2c',
  treeDark: '#24602a',
  treeHighlight: '#7cc04f',
  waterRipple: '#ffffff40',
  waterShore: '#ffffff59',
  waterDeep: '#3a8ccc',
  house: '#f3e6cc',
  houseShade: '#d9c7a3',
  roofRidge: '#ffffff4d',
  roadShadow: '#00000040',
  roadEdge: '#3c3f3a',
  road: '#6b6e68',
  roadMarking: '#f4efd2',
  tunnel: '#141412',
  tunnelInner: '#2a2925',
  tunnelArch: '#9a937f',
  tunnelArchLight: '#c4bca4',
  label: '#ffffff',
  labelHalo: '#1f2a1b',
  buildValid: '#2fbf4a',
  buildInvalid: '#e0402f',
  buildOutline: '#ffffff',
  vehicleOutline: '#1d1d1b',
  vehicleShadow: '#00000055',
  vehicleRoof: '#00000030',
  vehicleWaiting: '#f0a020',
  vehicleStuck: '#e0402f',
  vehicleGlass: '#bfe3ff',
  vehicleLight: '#fff6c2',
  heatBottleneck: '#ffffff',
  heatBlocked: '#e0402f',
  vehicleIndicator: '#ffb020',
  signalHousing: '#1d1d1b',
  signalOff: '#3a3a36',
  signal: { red: '#ff4b3a', amber: '#ffb020', green: '#3be36a' },
  signalSelected: '#ffffff',
  signalCandidate: '#ffffffb3',
  roundaboutRoad: '#5b5d58',
  roundaboutIsland: '#4f9a3a',
  roundaboutKerb: '#f4efd2',
  editSelected: '#ffffff73',
  editClosing: '#e0402f',
  editClosingLight: '#ffffff',
}
