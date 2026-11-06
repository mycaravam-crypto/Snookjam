import type { Terrain } from '../world/types'

export const TERRAIN_COLORS: Record<Terrain, string> = {
  grass: '#9cc46b',
  field: '#d9c46a',
  forest: '#4f8a3c',
  water: '#5aa0d6',
  settlement: '#c9b79c',
}

export const COLORS = {
  background: '#2d3a26',
  fieldFurrow: '#c2ab52',
  tree: '#2f6b2a',
  treeHighlight: '#5f9e48',
  waterRipple: '#7db8e3',
  house: '#b5533c',
  houseRoof: '#7d3426',
  roadEdge: '#4a4a46',
  road: '#77776f',
  roadMarking: '#e8e3c8',
  tunnel: '#1d1d1b',
  tunnelArch: '#8a8577',
  label: '#1f2a1b',
  labelHalo: '#ffffffcc',
  buildValid: '#2fbf4a',
  buildInvalid: '#e0402f',
  buildOutline: '#ffffff',
}
