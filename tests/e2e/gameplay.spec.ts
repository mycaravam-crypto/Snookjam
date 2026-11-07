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
  constructionOptions,
  createRoadGraph,
  findRoute,
  generateWorld,
  vehicleFollowingGap,
  type Point,
  type VehicleClass,
  type World,
} from '../../src/game'

const SEED = 77
const WIDE_JOINS = constructionOptions({ minJoinAngle: Math.PI / 3 })
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
        // Pick a curve with margin to spare (wide joins), so the slightly
        // different trace a real pointer records still validates.
        const check = checkPath(world, graph, trace[0]!, trace[24]!, trace.slice(1, -1), WIDE_JOINS)
        if (check.ok && check.path.length >= 4) return { trace, bends: check.path.length - 2 }
      }
    }
  }
  throw new Error(`no freehand road on seed ${SEED}`)
}

/** Straight-line samples between two points, as a drag records them. */
const line = (a: Point, b: Point, n = 10) =>
  Array.from({ length: n - 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * (i + 1)) / n, y: a.y + ((b.y - a.y) * (i + 1)) / n }))

/**
 * Open-endpoint construction (#29) on the level-1 map: a straight road from a
 * road node to open terrain (a dead end, with no road within 3 tiles of its
 * end), and a second road that later starts at that dead end and connects to
 * another road node.
 */
function deadEndThenConnect(world: World): { deadEnd: { from: Point; to: Point }; connect: { from: Point; to: Point } } {
  const graph = createRoadGraph(world)
  for (const start of graph.nodes().map((n) => n.position)) {
    for (let k = 0; k < 16; k++) {
      const angle = (k / 16) * 2 * Math.PI
      const end = { x: start.x + 5 * Math.cos(angle), y: start.y + 5 * Math.sin(angle) }
      if (graph.nearestLocation(end, 3)) continue
      const check = checkPath(world, graph, start, end, line(start, end), WIDE_JOINS)
      if (!check.ok || check.to) continue
      const trial = createRoadGraph(world)
      trial.connectToPoint(check.from.location, end, {}, check.path.slice(1, -1))
      for (const target of trial.nodes().map((n) => n.position)) {
        const d = Math.hypot(target.x - end.x, target.y - end.y)
        if (d < 3 || d > 9) continue
        const next = checkPath(world, trial, end, target, line(end, target), WIDE_JOINS)
        if (next.ok && next.to && next.path.length === 2) {
          return { deadEnd: { from: start, to: end }, connect: { from: end, to: target } }
        }
      }
    }
  }
  throw new Error(`no dead-end road on seed ${SEED}`)
}

/** Nodes where at least four roads meet. */
const fourWayNodes = (graph: { nodes(): { id: number }[]; edgesAt(id: number): unknown[] }) =>
  graph.nodes().filter((n) => graph.edgesAt(n.id).length >= 4).length

/**
 * A straight road between two road nodes that crosses an existing road
 * between its ends, so construction must create a new four-way junction.
 */
function crossingRoad(world: World): { from: Point; to: Point } {
  const graph = createRoadGraph(world)
  const before = fourWayNodes(graph)
  const nodes = graph.nodes().map((n) => n.position)
  for (const a of nodes) {
    for (const b of nodes) {
      const len = Math.hypot(a.x - b.x, a.y - b.y)
      if (len < 4 || len > 14) continue
      const check = checkPath(world, graph, a, b, line(a, b), WIDE_JOINS)
      if (!check.ok || !check.to || check.path.length !== 2) continue
      const trial = createRoadGraph(world)
      const result = trial.connect(check.from.location, check.to.location)
      const interior = result.nodes.slice(1, -1).filter((id) => trial.edgesAt(id).length >= 4)
      if (interior.length > 0 && fourWayNodes(trial) > before) return { from: a, to: b }
    }
  }
  throw new Error(`no crossing road on seed ${SEED}`)
}

const world = generateWorld(SEED)
const road = usefulRoad(world)
const curve = freehandRoad(world)
const offRoad = offRoadPoint(world)
const openEnded = deadEndThenConnect(world)
const crossing = crossingRoad(world)

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

async function play(page: Page, url = URL) {
  await page.goto(url)
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
    // Pause before comparing the model and HUD. Otherwise the real-time RAF
    // loop keeps changing congestion while Playwright waits for the assertion.
    await page.getByTestId('hud-pause').click()
    await expect(page.getByTestId('overlay')).toHaveAttribute('data-state', 'paused')
    const jammed = await state(page)
    expect(jammed.state).toBe('paused')
    expect(jammed.congestion).toBeGreaterThan(5)
    await expect(page.getByTestId('hud-congestion-text')).toContainText(`${Math.round(jammed.congestion)}%`)
    // Reopen the roads, resume and verify that queues clear.
    await page.getByTestId('overlay-resume').click()
    await expect(page.getByTestId('overlay')).toHaveCount(0)
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

  test('4d. draws a dead-end road, then connects to it later (#29)', async ({ page }) => {
    await play(page)
    const degreeNear = (p: Point) =>
      page.evaluate((p) => {
        const g = (window as any).__snookjam.session.value.graph
        const node = g.nodes().find((n: any) => Math.hypot(n.position.x - p.x, n.position.y - p.y) < 0.05)
        return node ? g.edgesAt(node.id).length : 0
      }, p)
    const before = await graphInfo(page)
    await drag(page, openEnded.deadEnd.from, openEnded.deadEnd.to)
    await expect(page.getByTestId('build-status')).toContainText('Road built')
    expect((await graphInfo(page)).edges).toBeGreaterThan(before.edges)
    // The free end is a real graph node with one road: a dead end.
    expect(await degreeNear(openEnded.deadEnd.to)).toBe(1)

    await drag(page, openEnded.connect.from, openEnded.connect.to)
    await expect(page.getByTestId('build-status')).toContainText('Road built')
    // The dead end now continues into the second road.
    expect(await degreeNear(openEnded.deadEnd.to)).toBe(2)
  })

  test('4e. a road crossing an existing road forms a junction (#29)', async ({ page }) => {
    await play(page)
    const junctions = () =>
      page.evaluate(() => {
        const g = (window as any).__snookjam.session.value.graph
        return g.nodes().filter((n: any) => g.edgesAt(n.id).length >= 4).length
      })
    const before = await junctions()
    await drag(page, crossing.from, crossing.to)
    await expect(page.getByTestId('build-status')).toContainText('Road built')
    expect(await junctions()).toBeGreaterThan(before)
    // Traffic keeps running through the new junction without errors.
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await fastForward(page, 20)
    expect(errors).toEqual([])
    expect((await state(page)).state).toBe('running')
  })

  test('4f. mixed traffic stays gap-safe and flowing under sustained congestion (#31)', async ({ page }) => {
    await play(page)
    const kinds: VehicleClass[] = ['car', 'van', 'truck']
    const gaps = Object.fromEntries(kinds.flatMap((f) => kinds.map((l) => [`${f}>${l}`, vehicleFollowingGap(f, l)])))
    const result = await page.evaluate((gaps) => {
      const s = (window as any).__snookjam.session.value
      s.sim.setVehicleMix({ car: 1, van: 1, truck: 1 })
      s.sim.queueSpawns(60)
      s.sim.setSpawnInterval(0.8)
      const exitedBefore = s.sim.stats().totalExited
      let overlaps = 0
      let peakWaiting = 0
      const windows: number[] = []
      for (let i = 0; i < 20 * 60 && s.state === 'running'; i++) {
        if (i % 200 === 0) windows.push(s.sim.stats().totalExited)
        s.tick()
        s.setCongestionForTesting(0) // keep the run going under heavy load
        peakWaiting = Math.max(peakWaiting, s.sim.stats().waiting)
        for (const edge of s.graph.edges()) {
          for (const from of [edge.a, edge.b]) {
            const lane = s.sim.laneOccupants(edge.id, from)
            for (let k = 1; k < lane.length; k++) {
              const gap = lane[k - 1].progress - lane[k].progress
              if (gap < (gaps[`${lane[k].kind}>${lane[k - 1].kind}`] ?? 0) - 1e-6) overlaps++
            }
          }
        }
      }
      const stats = s.sim.stats()
      windows.push(stats.totalExited)
      const perWindow = windows.slice(1).map((n, k) => n - windows[k]!)
      return { overlaps, peakWaiting, perWindow, exited: stats.totalExited - exitedBefore, kinds: [...new Set(s.sim.vehicles().map((v: any) => v.kind))].length }
    }, gaps)
    expect(result.overlaps).toBe(0)
    expect(result.peakWaiting).toBeGreaterThan(5) // queues really formed
    expect(result.kinds).toBeGreaterThan(1)
    // Traffic keeps leaving in every 10 s window once vehicles have had time
    // to cross the map: no gridlock or slow lock-up.
    expect(result.perWindow).toHaveLength(6)
    for (const n of result.perWindow.slice(2)) expect(n).toBeGreaterThan(0)
    expect(result.exited).toBeGreaterThan(15)
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

/** Open country near the middle of the map (clear of the toolbar and panels), 3+ tiles from any road. */
const openCountry = (() => {
  const graph = createRoadGraph(world)
  const cx = world.width / 2
  const cy = world.height / 2
  for (let r = 0; r < Math.max(cx, cy); r++) {
    for (let y = Math.floor(cy - r) + 0.5; y <= cy + r; y++) {
      for (let x = Math.floor(cx - r) + 0.5; x <= cx + r; x++) {
        if (!graph.nearestLocation({ x, y }, 3)) return { x, y }
      }
    }
  }
  throw new Error('no open country')
})()

/** Centre of the first junction on the current map that can take traffic lights. */
const signalJunction = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__snookjam.session.value
    const j = s.sim.junctions().find((j: any) => s.sim.isSignalJunction(j))
    return { key: j.key as number, center: j.center as Point }
  })

/** Buys one item through the shop panel, then closes it. */
async function buyInShop(page: Page, item: 'signal' | 'roundabout'): Promise<void> {
  await page.getByTestId('tool-shop').click()
  await page.getByTestId(`shop-buy-${item}`).click()
  await page.getByTestId('shop-close').click()
  await expect(page.getByTestId(`owned-${item}`)).not.toHaveText('×0')
}

const signalCount = (page: Page) => page.evaluate(() => (window as any).__snookjam.session.value.sim.signals().length as number)

test.describe('traffic lights (#32)', () => {
  test('L1. places, configures and removes lights with the mouse', async ({ page }) => {
    await play(page)
    await buyInShop(page, 'signal')
    await page.getByTestId('tool-signal').click()
    await expect(page.getByTestId('tool-signal')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('build-status')).toContainText('Tap a junction')

    // Tapping open country explains what to tap.
    const away = await toScreen(page, openCountry)
    await page.mouse.click(away.x, away.y)
    await expect(page.getByTestId('build-status')).toContainText('No junction there')
    expect(await signalCount(page)).toBe(0)

    const junction = await signalJunction(page)
    const at = await toScreen(page, junction.center)
    await page.mouse.click(at.x, at.y)
    await expect(page.getByTestId('build-status')).toContainText('Traffic lights added')
    await expect(page.getByTestId('signal-panel')).toBeVisible()
    expect(await signalCount(page)).toBe(1)

    await page.getByTestId('signal-green-15').click()
    await expect(page.getByTestId('signal-green-15')).toHaveAttribute('aria-pressed', 'true')
    const green = await page.evaluate((key) => (window as any).__snookjam.session.value.sim.signalAt(key).greenSec, junction.key)
    expect(green).toBe(15)

    // Tapping the junction again selects the existing lights rather than adding more.
    await page.mouse.click(at.x, at.y)
    await expect(page.getByTestId('build-status')).toContainText('Editing traffic lights')
    expect(await signalCount(page)).toBe(1)

    await page.getByTestId('signal-remove').click()
    await expect(page.getByTestId('signal-panel')).toHaveCount(0)
    expect(await signalCount(page)).toBe(0)

    // Back to roads: dragging builds again.
    await page.getByTestId('tool-road').click()
    await drag(page, road.from, road.to)
    await expect(page.getByTestId('build-status')).toContainText('Road built')
  })

  test('L2. places lights with touch', async ({ page }) => {
    await play(page)
    await buyInShop(page, 'signal')
    await page.getByTestId('tool-signal').click()
    const junction = await signalJunction(page)
    const at = await toScreen(page, junction.center)
    await page.locator('canvas.world').evaluate((el, p) => {
      const fire = (type: string) =>
        el.dispatchEvent(new PointerEvent(type, { clientX: p.x, clientY: p.y, pointerId: 12, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true }))
      fire('pointerdown')
      fire('pointerup')
    }, at)
    await expect(page.getByTestId('build-status')).toContainText('Traffic lights added')
    expect(await signalCount(page)).toBe(1)
    const scroll = await page.evaluate(() => ({ y: window.scrollY, selection: String(window.getSelection()) }))
    expect(scroll).toEqual({ y: 0, selection: '' })
  })

  test('L3. vehicles enter only on green and queue on red', async ({ page }) => {
    await play(page)
    await buyInShop(page, 'signal')
    await page.getByTestId('tool-signal').click()
    const junction = await signalJunction(page)
    const at = await toScreen(page, junction.center)
    await page.mouse.click(at.x, at.y)
    await page.getByTestId('signal-green-5').click()
    const result = await page.evaluate((key) => {
      const s = (window as any).__snookjam.session.value
      s.sim.queueSpawns(30)
      let holder: number | undefined
      const approach = new Map<number, any>()
      let admissions = 0
      let offGreen = 0
      let redWaits = 0
      const phases = new Set<string>()
      for (let i = 0; i < 20 * 90 && s.state === 'running'; i++) {
        s.tick()
        s.setCongestionForTesting(0)
        const view = s.sim.signalAt(key)
        phases.add(`${view.phase}:${view.clearance}`)
        const index = (step: any) => view.junction.approaches.findIndex((a: any) => a.edge === step.edge && a.node === step.to)
        const next = s.sim.junctionHolderAt(key)
        if (next !== undefined && next !== holder && approach.has(next)) {
          admissions++
          if (view.lights[index(approach.get(next))] !== 'green') offGreen++
        }
        holder = next
        for (const v of s.sim.vehicles()) {
          const step = v.steps[v.stepIndex]
          const k = index(step)
          if (k < 0) continue
          approach.set(v.id, step)
          if (view.lights[k] === 'red' && v.state === 'waiting') redWaits++
        }
      }
      return { admissions, offGreen, redWaits, phases: phases.size }
    }, junction.key)
    expect(result.offGreen).toBe(0)
    expect(result.admissions).toBeGreaterThan(3)
    expect(result.redWaits).toBeGreaterThan(0)
    // Every phase was green and cleared at least once.
    expect(result.phases).toBeGreaterThanOrEqual(4)
  })
})

const roadState = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__snookjam.session.value
    return { roads: s.roads().map((r: any) => r.state) as string[], edges: s.graph.edgeCount as number, nodes: s.graph.nodeCount as number }
  })

/** A point on a generated road well away from the useful road (more than 3 tiles from it). */
const generatedRoadPoint = (() => {
  const graph = createRoadGraph(world)
  for (const n of graph.nodes()) {
    const p = n.position
    const dx = road.to.x - road.from.x
    const dy = road.to.y - road.from.y
    const t = Math.max(0, Math.min(1, ((p.x - road.from.x) * dx + (p.y - road.from.y) * dy) / (dx * dx + dy * dy)))
    if (Math.hypot(p.x - road.from.x - t * dx, p.y - road.from.y - t * dy) > 3) return p
  }
  throw new Error('no generated road point')
})()

/** Middle of the useful road, for tapping it. */
const roadMiddle = { x: (road.from.x + road.to.x) / 2, y: (road.from.y + road.to.y) / 2 }

test.describe('road editing (#33)', () => {
  test('E1. undo and redo a road with the buttons and the keyboard', async ({ page }) => {
    await play(page)
    await expect(page.getByTestId('undo')).toBeDisabled()
    const before = await roadState(page)
    await drag(page, road.from, road.to)
    await expect(page.getByTestId('build-status')).toContainText('Road built')
    const built = await roadState(page)
    expect(built.roads).toEqual(['open'])

    await page.getByTestId('undo').click()
    await expect(page.getByTestId('build-status')).toContainText('Undo: road removed')
    expect(await roadState(page)).toEqual(before)
    await expect(page.getByTestId('redo')).toBeEnabled()

    await page.getByTestId('redo').click()
    await expect(page.getByTestId('build-status')).toContainText('Redo: road rebuilt')
    expect(await roadState(page)).toEqual(built)

    await page.keyboard.press('Control+z')
    expect(await roadState(page)).toEqual(before)
    await page.keyboard.press('Control+Shift+z')
    expect(await roadState(page)).toEqual(built)
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+y')
    expect(await roadState(page)).toEqual(built)
  })

  test('E2. selects and removes a player road; generated roads stay', async ({ page }) => {
    await play(page)
    const before = await roadState(page)
    await drag(page, road.from, road.to)
    await expect(page.getByTestId('build-status')).toContainText('Road built')

    await page.getByTestId('tool-remove').click()
    // A generated road cannot be removed.
    const generated = await toScreen(page, generatedRoadPoint)
    await page.mouse.click(generated.x, generated.y)
    await expect(page.getByTestId('build-status')).toContainText('Only roads you built can be removed')
    await expect(page.getByTestId('road-panel')).toHaveCount(0)

    const mid = await toScreen(page, roadMiddle)
    await page.mouse.click(mid.x, mid.y)
    await expect(page.getByTestId('road-panel')).toBeVisible()
    await page.getByTestId('road-remove').click()
    await expect(page.getByTestId('build-status')).toContainText(/Road removed|Road closed/)
    // Run until it is gone, then the network is exactly as before.
    await fastForward(page, 20)
    expect(await roadState(page)).toEqual({ ...before, roads: [] })
    // And the removal can be undone.
    await page.getByTestId('undo').click()
    expect((await roadState(page)).roads).toEqual(['open'])
  })

  test('E3. selects a road with touch', async ({ page }) => {
    await play(page)
    await drag(page, road.from, road.to)
    await page.getByTestId('tool-remove').click()
    const mid = await toScreen(page, roadMiddle)
    await page.locator('canvas.world').evaluate((el, p) => {
      const fire = (type: string) =>
        el.dispatchEvent(new PointerEvent(type, { clientX: p.x, clientY: p.y, pointerId: 13, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true }))
      fire('pointerdown')
      fire('pointerup')
    }, mid)
    await expect(page.getByTestId('road-panel')).toBeVisible()
  })

  test('E4. a busy road closes, traffic drives off it, then it is removed', async ({ page }) => {
    await play(page)
    const before = await roadState(page)
    await drag(page, road.from, road.to)
    await expect(page.getByTestId('build-status')).toContainText('Road built')
    // Run until a vehicle is driving on the new road.
    const busy = await page.evaluate(() => {
      const g = (window as any).__snookjam
      const s = g.session.value
      const id = s.roads()[0].id
      for (let i = 0; i < 20 * 120 && s.state === 'running'; i++) {
        s.tick()
        s.setCongestionForTesting(0)
        if (s.isRoadOccupied(id)) break
      }
      g.frame(0)
      return s.isRoadOccupied(id)
    })
    expect(busy).toBe(true)
    await page.getByTestId('tool-remove').click()
    const mid = await toScreen(page, roadMiddle)
    await page.mouse.click(mid.x, mid.y)
    await expect(page.getByTestId('road-panel-note')).toContainText('Cars are on it')
    await page.getByTestId('road-remove').click()
    await expect(page.getByTestId('build-status')).toContainText('Road closed')
    expect((await roadState(page)).roads).toEqual(['closing'])

    const result = await page.evaluate(() => {
      const s = (window as any).__snookjam.session.value
      let jumps = 0
      const last = new Map<number, { x: number; y: number }>()
      for (let i = 0; i < 20 * 60 && s.state === 'running'; i++) {
        s.tick()
        s.setCongestionForTesting(0)
        for (const v of s.sim.vehicles()) {
          const p = s.sim.positionOf(v).position
          const q = last.get(v.id)
          if (q && Math.hypot(p.x - q.x, p.y - q.y) > 0.2) jumps++
          last.set(v.id, p)
        }
        if (s.roads().length === 0) break
      }
      return { jumps, roads: s.roads().length }
    })
    expect(result).toEqual({ jumps: 0, roads: 0 })
    expect(await roadState(page)).toEqual({ ...before, roads: [] })
  })
})

/**
 * With two-lane spacing and junction boxes (#22), 40 x 30 maps hold roughly
 * 40-90 vehicles at once depending on their road network. Seed 36 has room
 * for about 90; the 100-vehicle simulation cost is covered on a larger map in
 * tests/integration/gameplay.test.ts.
 */
const PERF_URL = '?seed=36&test'

test('stays responsive with about 100 active vehicles', async ({ page }) => {
  await play(page, PERF_URL)
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

test.describe('shop, coins and roundabouts', () => {
  test('S1. cars earn coins, the shop sells a roundabout and the tool builds it', async ({ page }) => {
    await play(page)
    const coins = () => page.evaluate(() => (window as any).__snookjam.snapshot.value.coins as number)
    const start = await coins()
    await expect(page.getByTestId('hud-coins')).toContainText(String(start))

    // Without stock, the roundabout tool points at the shop.
    await page.getByTestId('tool-roundabout').click()
    const junction = await signalJunction(page)
    const at = await toScreen(page, junction.center)
    await page.mouse.click(at.x, at.y)
    await expect(page.getByTestId('build-status')).toContainText('buy one in the shop')

    // Traffic through the tunnels pays out until a roundabout is affordable.
    await page.getByTestId('tool-shop').click()
    await expect(page.getByTestId('shop-buy-roundabout')).toBeDisabled()
    await page.evaluate(() => {
      const g = (window as any).__snookjam
      const s = g.session.value
      for (let i = 0; i < 20 * 120 && s.coins < 40; i++) {
        s.tick()
        s.setCongestionForTesting(0)
      }
      g.frame(0)
    })
    expect(await coins()).toBeGreaterThanOrEqual(40)
    expect(await page.evaluate(() => (window as any).__snookjam.snapshot.value.score as number)).toBeGreaterThan(0)
    await page.getByTestId('shop-buy-roundabout').click()
    await expect(page.getByTestId('owned-roundabout')).toHaveText('×1')
    await page.getByTestId('shop-close').click()

    await page.mouse.click(at.x, at.y)
    await expect(page.getByTestId('build-status')).toContainText('Roundabout built')
    await expect(page.getByTestId('roundabout-panel')).toBeVisible()
    await expect(page.getByTestId('owned-roundabout')).toHaveText('×0')
    expect(await page.evaluate(() => (window as any).__snookjam.session.value.sim.roundabouts().length)).toBe(1)

    await page.getByTestId('roundabout-remove').click()
    await expect(page.getByTestId('owned-roundabout')).toHaveText('×1')
    expect(await page.evaluate(() => (window as any).__snookjam.session.value.sim.roundabouts().length)).toBe(0)
  })
})
