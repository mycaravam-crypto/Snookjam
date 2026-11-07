/**
 * Browser tests for level objectives, scoring and sandbox mode (#35).
 * `?test` exposes the controller as `window.__snookjam` for fast-forwarding.
 */
import { expect, test, type Page } from '@playwright/test'

const URL = '?seed=77&test'

async function fastForward(page: Page, seconds: number, holdCongestion = true) {
  await page.evaluate(
    ({ steps, hold }) => {
      const game = (window as any).__snookjam
      const s = game.session.value
      for (let i = 0; i < steps && s.state === 'running'; i++) {
        s.tick()
        if (hold) s.setCongestionForTesting(0)
      }
      game.frame(0)
    },
    { steps: Math.round(seconds * 20), hold: holdCongestion },
  )
}

const snapshot = (page: Page) => page.evaluate(() => (window as any).__snookjam.snapshot.value)

test('objectives mode shows progress, completes level 1 and banks the score', async ({ page }) => {
  await page.goto(URL)
  await page.getByTestId('play-objectives').click()
  await expect(page.getByTestId('objectives')).toBeVisible()
  await expect(page.getByTestId('objective-journeys')).toContainText('Complete 70 journeys')
  await expect(page.getByTestId('hud-score')).toHaveText('0')

  await fastForward(page, 60)
  const mid = await snapshot(page)
  expect(mid.network.completedJourneys).toBeGreaterThan(0)
  await expect(page.getByTestId('objective-journeys-value')).toHaveText(`${mid.network.completedJourneys} / 70`)
  await expect(page.getByTestId('hud-score')).toHaveText(String(mid.score))

  await fastForward(page, 125)
  const done = await snapshot(page)
  expect(done.state).toBe('levelComplete')
  expect(done.objectives.every((o: any) => o.status === 'met')).toBe(true)
  expect(done.levelScore).toBe(10 * done.network.completedJourneys + 50 * done.objectives.length)
  await expect(page.getByTestId('overlay-objectives')).toContainText('✓ Complete 70 journeys')
  await expect(page.getByTestId('overlay-score')).toContainText(`Total ${done.score}`)

  await page.getByTestId('overlay-next').click()
  await expect(page.getByTestId('hud-level')).toHaveText('2')
  await expect(page.getByTestId('objective-averageWait')).toBeVisible()
  await expect(page.getByTestId('hud-score')).toHaveText(String(done.score))
})

test('objectives mode ends the run when a goal is missed', async ({ page }) => {
  await page.goto(URL)
  await page.getByTestId('play-objectives').click()
  // Close every road for the whole level so the journeys goal cannot be met.
  await page.evaluate(() => {
    const s = (window as any).__snookjam.session.value
    for (const e of s.graph.edges()) s.graph.setBlocked(e.id, true)
  })
  await fastForward(page, 185)
  const over = await snapshot(page)
  expect(over).toMatchObject({ state: 'gameOver', endReason: 'objectives' })
  await expect(page.getByRole('heading', { name: 'Objectives missed' })).toBeVisible()
  await expect(page.getByTestId('overlay-objectives')).toContainText('✕ Complete 70 journeys')
  await page.getByTestId('overlay-restart').click()
  await expect(page.getByTestId('hud-score')).toHaveText('0')
})

test('sandbox mode runs past the level timer and survives full congestion', async ({ page }) => {
  await page.goto(URL)
  await page.getByTestId('play-sandbox').click()
  await expect(page.getByTestId('hud-level')).toHaveText('Sandbox')
  await expect(page.getByTestId('hud-time')).not.toContainText('/')
  await expect(page.getByTestId('objectives')).toHaveCount(0)
  await fastForward(page, 200, false)
  await page.evaluate(() => (window as any).__snookjam.session.value.setCongestionForTesting(100))
  await fastForward(page, 5, false)
  const snap = await snapshot(page)
  expect(snap.state).toBe('running')
  expect(snap.levelTime).toBeGreaterThan(200)
  await expect(page.getByTestId('overlay')).toHaveCount(0)
})
