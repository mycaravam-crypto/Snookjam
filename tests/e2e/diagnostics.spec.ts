/**
 * Browser tests for traffic diagnostics (#34): heatmap overlay and the
 * statistics panel. Like gameplay.spec.ts, `?test` exposes the controller as
 * `window.__snookjam` so the sim can be fast-forwarded in fixed steps.
 */
import { expect, test, type Page } from '@playwright/test'

const URL = '?seed=77&test'

async function play(page: Page, url = URL) {
  await page.goto(url)
  await page.getByTestId('play').click()
  await expect(page.getByTestId('game-shell')).toBeVisible()
}

async function fastForward(page: Page, seconds: number, setup = '') {
  await page.evaluate(
    ({ steps, setup }) => {
      const game = (window as any).__snookjam
      const s = game.session.value
      if (setup) new Function('s', setup)(s)
      for (let i = 0; i < steps && s.state === 'running'; i++) {
        s.tick()
        s.setCongestionForTesting(0)
      }
      game.frame(0)
    },
    { steps: Math.round(seconds * 20), setup },
  )
}

const snapshot = (page: Page) => page.evaluate(() => (window as any).__snookjam.snapshot.value)

const canvasHash = (page: Page) =>
  page.locator('canvas').first().evaluate((el: HTMLCanvasElement) => {
    const { data } = el.getContext('2d')!.getImageData(0, 0, el.width, el.height)
    let h = 0
    for (let i = 0; i < data.length; i += 4 * 13) h = (Math.imul(h, 31) + data[i]! + data[i + 1]! * 7 + data[i + 2]! * 13) | 0
    return h
  })

test('heatmap toggles without pausing and highlights jammed roads and junctions', async ({ page }) => {
  await play(page)
  await fastForward(page, 8)
  // Close every road so vehicles queue, then let the heat build up.
  await fastForward(page, 15, `for (const e of s.graph.edges()) s.graph.setBlocked(e.id, true)`)

  const heat = await page.evaluate(() => {
    const d = (window as any).__snookjam.session.value.diagnostics
    return { roads: d.roads().length, blocked: d.blockedJunctions().length }
  })
  expect(heat.roads).toBeGreaterThan(0)
  expect(heat.blocked).toBeGreaterThan(0)

  // Pause so the comparison is between two still frames.
  await page.getByTestId('hud-pause').click()
  const toggle = page.getByTestId('hud-heatmap')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  const plain = await canvasHash(page)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => canvasHash(page)).not.toBe(plain)
  await page.getByTestId('overlay-resume').click()

  // Keyboard toggle, and the simulation keeps running throughout.
  const before = (await snapshot(page)).levelTime
  await page.keyboard.press('h')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('h')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect((await snapshot(page)).state).toBe('running')
  await expect.poll(async () => (await snapshot(page)).levelTime).toBeGreaterThan(before)
})

test('statistics panel reports journeys, throughput and blocked junctions consistently', async ({ page }) => {
  await play(page)
  await expect(page.getByTestId('network-panel')).toHaveCount(0)
  await page.getByTestId('hud-stats').click()
  const panel = page.getByTestId('network-panel')
  await expect(panel).toBeVisible()
  await expect(page.getByTestId('network-travel')).toHaveText('—')

  await fastForward(page, 60)
  await page.getByTestId('hud-pause').click()
  const snap = await snapshot(page)
  expect(snap.network.completedJourneys).toBeGreaterThan(0)
  expect(snap.network.completedJourneys).toBe(snap.vehiclesExited)
  await expect(page.getByTestId('network-journeys')).toHaveText(String(snap.network.completedJourneys))
  await expect(page.getByTestId('network-active')).toHaveText(String(snap.activeVehicles))
  await expect(page.getByTestId('network-throughput')).toHaveText(`${snap.network.throughputPerMin.toFixed(1)}/min`)
  await expect(page.getByTestId('network-travel')).toHaveText(/\d s$/)
  await page.getByTestId('overlay-resume').click()

  await fastForward(page, 10, `for (const e of s.graph.edges()) s.graph.setBlocked(e.id, true)`)
  await expect.poll(async () => Number(await page.getByTestId('network-blocked').textContent())).toBeGreaterThan(0)

  // The legend appears with the heatmap; I closes the panel.
  await page.getByTestId('hud-heatmap').click()
  await expect(page.getByTestId('network-legend')).toBeVisible()
  await page.keyboard.press('i')
  await expect(panel).toHaveCount(0)
})

test('diagnostics fit a narrow portrait screen', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 375, height: 740 } })
  await play(page)
  await page.getByTestId('hud-heatmap').click()
  await page.getByTestId('hud-stats').click()
  const panel = await page.getByTestId('network-panel').boundingBox()
  expect(panel).not.toBeNull()
  expect(panel!.x).toBeGreaterThanOrEqual(0)
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(375)
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(scroll).toBeLessThanOrEqual(375)
  await page.screenshot({ path: test.info().outputPath('narrow.png') })
  await page.close()
})

test('stays responsive with the heatmap and statistics on at about 100 vehicles', async ({ page }) => {
  await play(page, '?seed=36&test')
  await page.getByTestId('hud-heatmap').click()
  await page.getByTestId('hud-stats').click()
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
      new Promise<{ active: number; mean: number }>((resolve) => {
        const s = (window as any).__snookjam.session.value
        const gaps: number[] = []
        let last = performance.now()
        const end = last + 3000
        const tick = (now: number) => {
          s.setCongestionForTesting(0)
          gaps.push(now - last)
          last = now
          if (now < end) requestAnimationFrame(tick)
          else resolve({ active: s.sim.stats().active, mean: gaps.reduce((x, y) => x + y, 0) / gaps.length })
        }
        requestAnimationFrame(tick)
      }),
  )
  console.info(`perf with diagnostics: ${result.active} vehicles, mean ${result.mean.toFixed(1)} ms`)
  expect(result.active).toBeGreaterThanOrEqual(80)
  expect(result.mean).toBeLessThan(50)
})
