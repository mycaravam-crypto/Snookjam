import { defineConfig, devices } from '@playwright/test'

// The production build is served by `vite preview`. On GitHub Actions the
// build uses the Pages base path, so the app lives under /Snookjam/.
const PORT = 4173
const base = process.env.GITHUB_ACTIONS === 'true' ? '/Snookjam/' : '/'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  fullyParallel: true,
  // Browser tests are deterministic and already exercise the real UI. Avoid
  // silently doubling a slow CI run when a genuine regression occurs.
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['dot'], ['github']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}${base}`,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}${base}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
