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

const world = generateWorld(SEED)
const road = usefulRoad(world)

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
  test('starts the game and renders moving traffic', async ({ page }) => {
    await page.goto(URL)
    await expect(page.getByRole('heading', { name: 'Snookjam' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'How to play' })).toBeVisible()
    await page.getByTestId('play').click()
    await expect(page.getByTestId('hud-level')).toHaveText('1')
    await expect(page.getByTestId('hud-congestion-text')).toContainText('0%')
    expect((await state(page)).state).toBe('running')
    await expect(page.locator('canvas').first()).toBeVisible()
    await expect.poll(async () => Number((await page.getByTestId('hud-cars').textContent())?.split('/')[0]?.trim())).toBeGreaterThan(0)
    const before = await canvasHash(page)
    await expect.poll(() => canvasHash(page), { timeout: 5000 }).not.toBe(before)
    await expect(page.getByTestId('hud-time')).not.toContainText('0:00 /')
  })

  test('builds and clears congestion with pause controls', async ({ page }) => {
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
    await page.keyboard.press('p')
    await expect(page.getByTestId('overlay')).toHaveAttribute('data-state', 'paused')
    await page.keyboard.press('p')
    await expect(page.getByTestId('overlay')).toHaveCount(0)
  })

  test('builds a road and reroutes traffic', async ({ page }) => {
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

  test('recovers cleanly from gridlock', async ({ page }) => {
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
