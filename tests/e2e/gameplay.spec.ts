/**
 * Browser-level tests of the critical player flow (#9), run against the
 * production build with Playwright (Chromium).
 *
 * World coordinates are converted to screen positions with the game's own
 * viewport maths, so the tests drag exactly where a player would.
 */
import { expect, test, type Page } from '@playwright/test'
import { checkConnection, createRoadGraph, fitViewport, generateWorld, worldToScreen, type Point } from '../../src/game'

const SEED = 77

/** A valid road and an invalid drag on the level-1 map for SEED. */
function scenario() {
  const world = generateWorld(SEED)
  const graph = createRoadGraph(world)
  const nodes = graph.nodes().map((n) => n.position)
  let road: { from: Point; to: Point } | undefined
  for (let i = 0; i < nodes.length && !road; i++) {
    for (let j = i + 1; j < nodes.length && !road; j++) {
      const d = Math.hypot(nodes[i]!.x - nodes[j]!.x, nodes[i]!.y - nodes[j]!.y)
      if (d >= 4 && d <= 10 && checkConnection(world, graph, nodes[i]!, nodes[j]!).ok) road = { from: nodes[i]!, to: nodes[j]! }
    }
  }
  if (!road) throw new Error(`no buildable road found for seed ${SEED}`)
  // Dragging from a road to open countryside far from any road is rejected.
  const offRoad = findOffRoadPoint(graph)
  return { world, road, invalid: { from: road.from, to: offRoad } }
}

function findOffRoadPoint(graph: ReturnType<typeof createRoadGraph>): Point {
  for (let y = 2.5; y < 28; y++) {
    for (let x = 2.5; x < 38; x++) {
      if (!graph.nearestLocation({ x, y }, 3)) return { x, y }
    }
  }
  throw new Error('no off-road point')
}

async function toScreen(page: Page, world: { width: number; height: number }, point: Point) {
  const box = await page.getByTestId('world-canvas').or(page.locator('canvas.world')).first().boundingBox()
  if (!box) throw new Error('canvas not visible')
  // Must match WorldCanvas: fitViewport(world, canvas CSS size, 8px padding).
  const viewport = fitViewport(world.width, world.height, box.width, box.height, 8)
  const p = worldToScreen(viewport, point)
  return { x: box.x + p.x, y: box.y + p.y }
}

async function drag(page: Page, world: { width: number; height: number }, from: Point, to: Point) {
  const a = await toScreen(page, world, from)
  const b = await toScreen(page, world, to)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10)
  await page.mouse.up()
}

test.describe('critical player flow', () => {
  const { world, road, invalid } = scenario()

  test.beforeEach(async ({ page }) => {
    await page.goto(`?seed=${SEED}`)
  })

  test('opens Snookjam and starts a game', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Snookjam' })).toBeVisible()
    await page.getByTestId('play').click()
    await expect(page.getByTestId('game-shell')).toBeVisible()
    await expect(page.getByTestId('seed')).toContainText(String(SEED))
  })

  test('draws the map on the canvas', async ({ page }) => {
    await page.getByTestId('play').click()
    const canvas = page.locator('canvas').first()
    await expect(canvas).toBeVisible()
    // The canvas has been painted (not a blank bitmap).
    const painted = await canvas.evaluate((el: HTMLCanvasElement) => {
      const ctx = el.getContext('2d')!
      const { data } = ctx.getImageData(0, 0, el.width, el.height)
      const colours = new Set<number>()
      for (let i = 0; i < data.length; i += 4 * 97) colours.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!)
      return colours.size
    })
    expect(painted).toBeGreaterThan(5)
  })

  test('builds a valid road by dragging between roads', async ({ page }) => {
    await page.getByTestId('play').click()
    await expect(page.getByTestId('built')).toContainText('0')
    await drag(page, world, road.from, road.to)
    await expect(page.getByTestId('build-status')).toContainText('Road built')
    await expect(page.getByTestId('built')).toContainText('1')
  })

  test('rejects an invalid drag and leaves the network unchanged', async ({ page }) => {
    await page.getByTestId('play').click()
    await drag(page, world, invalid.from, invalid.to)
    await expect(page.getByTestId('build-status')).toContainText('Not built')
    await expect(page.getByTestId('built')).toContainText('0')
  })

  test('does not scroll or select text while dragging', async ({ page }) => {
    await page.getByTestId('play').click()
    await drag(page, world, road.from, road.to)
    const state = await page.evaluate(() => ({ scrollY: window.scrollY, selection: String(window.getSelection()) }))
    expect(state).toEqual({ scrollY: 0, selection: '' })
  })
})
