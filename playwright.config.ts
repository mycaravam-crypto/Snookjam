import { defineConfig, devices } from '@playwright/test'

// The production build is served by `vite preview`. On GitHub Actions the
// build uses the Pages base path, so the app lives under /Snookjam/.
const PORT = 4173
const base = process.env.GITHUB_ACTIONS === 'true' ? '/Snookjam/' : '/'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}${base}`,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}${base}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
