/**
 * Browser-level tests of the critical player flow (#9), run against the
 * production build with Playwright (Chromium).
 *
 * - World points are converted to screen positions by the app itself
 *   (`__snookjam.worldToClient`), so drags land where a player would drag.
 * - `?test` exposes the GameController as `window.__snookjam`. Tests use it
 *   to read state and to fast-forward the simulation in fixed steps instead
 *   of waiting in real time; all player actions go through the real UI.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  checkConnection,
  checkPath,
  createRoadGraph,
  findRoute,
  generateWorld,
  type Point,
  type World,
} from '../../src/game'

const SEED = 77
const URL = `?seed=${SEED}&test`

/**
 * A buildable road on the level-1 map that becomes part of at least one
 * portal-to-portal route, so traffic will actually use it after rerouting.
 */
function usefulRoad(world: World): { from: Point; to: Point } {
  const graph = createRoadGraph(world)
  const nodes = graph.nodes().map((n) => n.position)
  const portals = world.portals.map((p) => p.nodeId)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const [a, b] = [nodes[i]!, nodes[j]!]
      if (Math.hypot(a.x - b.x, a.y - b.y) < 4) continue
      const check = checkConnection(world, graph, a, b)
      if (!check.ok) continue
      const trial = createRoadGraph(world)
      const { edge } = trial.connect(check.from.location, check.to.location)
      const used = portals.some((o) =>
        portals.some((d) => {
          const r = o !== d && findRoute(trial, o, d)
          return r && r.ok && r.route.steps.some((s) => s.edge === edge)
        }),
      )
      if (used) return { from: a, to: b }
    }
  }
  throw new Error(`no useful road on seed ${SEED}`)
}

function offRoadPoint(world: World): Point {
  const graph = createRoadGraph(world)
  for (let y = 2.5; y < world.height - 2; y++) {
    for (let x = 2.5; x < world.width - 2; x++) if (!graph.nearestLocation({ x, y }, 3)) return { x, y }
  }
  throw new Error('no off-road point')
}

/**
 * A freehand road (#18) on the level-1 map: an arc between two road points
 * that validates as a curved, multi-segment road. The drawn ends are offset
 * half a tile from the road so snapping is exercised.
 */
function freehandRoad(world: World): { trace: Point[]; bends: number } {
  const graph = createRoadGraph(world)
  const nodes = graph.nodes().map((n) => n.position)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = 0; j < nodes.length; j++) {
      const [a, b] = [nodes[i]!, nodes[j]!]
      const len = Math.hypot(a.x - b.x, a.y - b.y)
      if (i === j || len < 5 || len > 12) continue
      for (const bulge of [2, -2, 3, -3]) {
        const nx = -(b.y - a.y) / len
        const ny = (b.x - a.x) / len
        const trace = Array.from({ length: 25 }, (_, k) => {
          const t = k / 24
          const off = bulge * Math.sin(Math.PI * t) + (k === 0 || k === 24 ? 0.5 : 0)
          return { x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off }
        })
        const check = checkPath(world, graph, trace[0]!, trace[24]!, trace.slice(1, -1))
        if (check.ok && check.path.length >= 4) return { trace, bends: check.path.length - 2 }
      }
    }
  }
  throw new Error(`no freehand road on seed ${SEED}`)
}

const world = generateWorld(SEED)
const road = usefulRoad(world)
const curve = freehandRoad(world)
const offRoad = offRoadPoint(world)

/** Page client coordinates of a world point, via the app's own mapping (handles portrait rotation). */
async function toScreen(page: Page, point: Point) {
  const p = await page.evaluate((pt) => (window as any).__snookjam.worldToClient(pt), point)
  if (!p) throw new Error('canvas not ready')
  return p as { x: number; y: number }
}

async function drag(page: Page, from: Point, to: Point) {
  const a = await toScreen(page, from)
  const b = await toScreen(page, to)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10)
  await page.mouse.up()
}

/** Draws along `trace` with the mouse, or with touch Pointer Events. */
async function drawPath(page: Page, trace: Point[], pointerType: 'mouse' | 'touch') {
  const pts = []
  for (const p of trace) pts.push(await toScreen(page, p))
  if (pointerType === 'mouse') {
    await page.mouse.move(pts[0]!.x, pts[0]!.y)
    await page.mouse.down()
    for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y)
    await page.mouse.up()
    return
  }
  await page.locator('canvas.world').evaluate((el, pts) => {
    const fire = (type: string, p: { x: number; y: number }) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          clientX: p.x,
          clientY: p.y,
          pointerId: 11,
          pointerType: 'touch',
          isPrimary: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    fire('pointerdown', pts[0]!)
    for (const p of pts.slice(1)) fire('pointermove', p)
    fire('pointerup', pts[pts.length - 1]!)
  }, pts)
}

/** Runs simulation steps inside the page (fixed 50 ms steps). */
async function fastForward(page: Page, seconds: number, setup = '') {
  await page.evaluate(
    ({ steps, setup }) => {
      const game = (window as any).__snookjam
      const s = game.session.value
      if (setup) new Function('s', setup)(s)
      for (let i = 0; i < steps && s.state === 'running'; i++) s.tick()
      game.frame(0)
    },
    { steps: Math.round(seconds * 20), setup },
  )
}

const state = (page: Page) => page.evaluate(() => (window as any).__snookjam.snapshot.value)
const graphInfo = (page: Page) =>
  page.evaluate(() => {
    const g = (window as any).__snookjam.session.value.graph
    return { edges: g.edgeCount, version: g.version, maxEdge: Math.max(...g.edges().map((e: any) => e.id)) }
  })

async function play(page: Page) {
  await page.goto(URL)
  await page.getByTestId('play').click()
  await expect(page.getByTestId('game-shell')).toBeVisible()
}

/** Cheap fingerprint of the canvas pixels. */
const canvasHash = (page: Page) =>
  page.locator('canvas').first().evaluate((el: HTMLCanvasElement) => {
    const { data } = el.getContext('2d')!.getImageData(0, 0, el.width, el.height)
    let h = 0
    for (let i = 0; i < data.length; i += 4 * 13) h = (Math.imul(h, 31) + data[i]! + data[i + 1]! * 7 + data[i + 2]! * 13) | 0
    return h
  })

test.describe('critical player flow', () => {
  test('1. opens Snookjam and starts a level', async ({ page }) => {
    await page.goto(URL)
    await expect(page.getByRole('heading', { name: 'Snookjam' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'How to play' })).toBeVisible()
    await page.getByTestId('play').click()
    await expect(page.getByTestId('hud-level')).toHaveText('1')
    await expect(page.getByTestId('hud-congestion-text')).toContainText('0%')
    expect((await state(page)).state).toBe('running')
  })

  test('2. shows the map, tunnels and moving vehicles', async ({ page }) => {
    await play(page)
    await expect(page.locator('canvas').first()).toBeVisible()
    await expect.poll(async () => Number(await page.getByTestId('hud-cars').textContent())).toBeGreaterThan(0)
    // Vehicles move, so the picture changes between frames.
    const before = await canvasHash(page)
    await expect.poll(() => canvasHash(page), { timeout: 5000 }).not.toBe(before)
    await expect(page.getByTestId('hud-time')).not.toContainText('0:00 /')
  })

  test('3. congestion responds to queues', async ({ page }) => {
    await play(page)
    await fastForward(page, 5) // let traffic enter the map
    expect((await state(page)).activeVehicles).toBeGreaterThan(0)
    // Close every road so the vehicles on the map queue at their junctions.
    await fastForward(page, 10, `for (const e of s.graph.edges()) s.graph.setBlocked(e.id, true)`)
    const jammed = await state(page)
    expect(jammed.state).toBe('running')
    expect(jammed.congestion).toBeGreaterThan(5)
    await expect(page.getByTestId('hud-congestion-text')).toContainText(`${Math.round(jammed.congestion)}%`)
    // Reopen the roads: queues clear and congestion falls.
    await fastForward(page, 40, `for (const e of s.graph.edges()) s.graph.setBlocked(e.id, false)`)
    const cleared = await state(page)
    expect(cleared.state).toBe('running')
    expect(cleared.congestion).toBeLessThan(jammed.congestion)
  })

  test('4–5. builds a road by dragging; traffic uses it after rerouting', async ({ page }) => {
    await play(page)
    const before = await graphInfo(page)
    await drag(page, road.from, road.to)
    await expect(page.getByTestId('build-status')).toContainText('Road built')
    const after = await graphInfo(page)
    expect(after.edges).toBeGreaterThan(before.edges)
    expect(after.version).toBeGreaterThan(before.version)
    // Within simulated time, some vehicle routes over the new edge.
    const used = await page.evaluate((edge) => {
      const s = (window as any).__snookjam.session.value
      for (let i = 0; i < 20 * 120 && s.state === 'running'; i++) {
        s.tick()
        if (s.sim.vehicles().some((v: any) => v.steps.some((st: any) => st.edge === edge))) return true
      }
      return false
    }, after.maxEdge)
    expect(used).toBe(true)
  })

  for (const pointerType of ['mouse', 'touch'] as const) {
    test(`4c. draws a curved freehand road with ${pointerType} (#18)`, async ({ page }) => {
      await play(page)
      const before = await graphInfo(page)
      await drawPath(page, curve.trace, pointerType)
      await expect(page.getByTestId('build-status')).toContainText('Road built')
      // One edge per segment (bends + 1) plus one per split road, net of the split ones.
      expect((await graphInfo(page)).edges).toBeGreaterThanOrEqual(before.edges + curve.bends + 1)
      const scroll = await page.evaluate(() => ({ y: window.scrollY, selection: String(window.getSelection()) }))
      expect(scroll).toEqual({ y: 0, selection: '' })
    })
  }

  test('4b. rejects an invalid drag and leaves the graph unchanged', async ({ page }) => {
    await play(page)
    const before = await graphInfo(page)
    await drag(page, road.from, offRoad)
    await expect(page.getByTestId('build-status')).toContainText('Not built')
    expect((await graphInfo(page)).edges).toBe(before.edges)
    const scroll = await page.evaluate(() => ({ y: window.scrollY, selection: String(window.getSelection()) }))
    expect(scroll).toEqual({ y: 0, selection: '' })
  })

  test('6. pauses and resumes', async ({ page }) => {
    await play(page)
    await fastForward(page, 5)
    await page.getByTestId('hud-pause').click()
    await expect(page.getByTestId('overlay')).toHaveAttribute('data-state', 'paused')
    const paused = await state(page)
    const vehicles = await page.evaluate(() => JSON.stringify((window as any).__snookjam.session.value.sim.vehicles()))
    await page.waitForTimeout(1000)
    expect((await state(page)).levelTime).toBe(paused.levelTime)
    expect(await page.evaluate(() => JSON.stringify((window as any).__snookjam.session.value.sim.vehicles()))).toBe(vehicles)

    await page.getByTestId('overlay-resume').click()
    await expect(page.getByTestId('overlay')).toHaveCount(0)
    await expect.poll(async () => (await state(page)).levelTime).toBeGreaterThan(paused.levelTime)

    // Keyboard shortcut.
    await page.keyboard.press('p')
    await expect(page.getByTestId('overlay')).toHaveAttribute('data-state', 'paused')
    await page.keyboard.press('p')
    await expect(page.getByTestId('overlay')).toHaveCount(0)
  })

  test('7. game over, then restart cleanly', async ({ page }) => {
    await play(page)
    const initial = await graphInfo(page)
    await drag(page, road.from, road.to)
    await expect(page.getByTestId('build-status')).toContainText('Road built')
    await fastForward(page, 15, 's.setCongestionForTesting(100)')
    await expect(page.getByTestId('overlay')).toHaveAttribute('data-state', 'gameOver')
    await expect(page.getByRole('heading', { name: 'Gridlock!' })).toBeVisible()

    await page.getByTestId('overlay-restart').click()
    await expect(page.getByTestId('overlay')).toHaveCount(0)
    await expect(page.getByTestId('hud-level')).toHaveText('1')
    const restarted = await state(page)
    expect(restarted.state).toBe('running')
    expect(restarted.congestion).toBe(0)
    expect(restarted.levelTime).toBeLessThan(1)
    expect(restarted.vehiclesExited).toBe(0)
    expect((await graphInfo(page)).edges).toBe(initial.edges) // built road is gone
  })

  test('completes a level and continues to the next', async ({ page }) => {
    await play(page)
    await fastForward(page, 181)
    await expect(page.getByTestId('overlay')).toHaveAttribute('data-state', 'levelComplete')
    await page.getByTestId('overlay-next').click()
    await expect(page.getByTestId('hud-level')).toHaveText('2')
    const s = await state(page)
    expect(s).toMatchObject({ level: 2, state: 'running', congestion: 0 })
  })
})

test('stays responsive with about 100 active vehicles', async ({ page }) => {
  await play(page)
  // Fill the map, holding congestion at 0 so the run keeps going.
  await page.evaluate(() => {
    const s = (window as any).__snookjam.session.value
    s.sim.queueSpawns(100)
    s.sim.setSpawnInterval(0.8)
    for (let i = 0; i < 20 * 90 && s.sim.stats().active < 100; i++) {
      s.tick()
      s.setCongestionForTesting(0)
    }
  })
  const result = await page.evaluate(
    () =>
      new Promise<{ active: number; frames: number; p95: number; mean: number }>((resolve) => {
        const s = (window as any).__snookjam.session.value
        const gaps: number[] = []
        let last = performance.now()
        const end = last + 3000
        const tick = (now: number) => {
          s.setCongestionForTesting(0)
          gaps.push(now - last)
          last = now
          if (now < end) requestAnimationFrame(tick)
          else {
            gaps.sort((a, b) => a - b)
            const mean = gaps.reduce((x, y) => x + y, 0) / gaps.length
            resolve({ active: s.sim.stats().active, frames: gaps.length, p95: gaps[Math.floor(gaps.length * 0.95)]!, mean })
          }
        }
        requestAnimationFrame(tick)
      }),
  )
  console.info(`perf: ${result.active} vehicles, ${result.frames} frames in 3 s, mean ${result.mean.toFixed(1)} ms, p95 ${result.p95.toFixed(1)} ms`)
  expect(result.active).toBeGreaterThanOrEqual(80)
  // Responsive: mean frame time under 50 ms (20+ fps) even on a CI runner.
  expect(result.mean).toBeLessThan(50)
})
