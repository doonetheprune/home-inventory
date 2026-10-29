import { defineConfig, devices } from '@playwright/test';

/** End-to-end tests against a real server with in-memory storage. Run `npm run build:web` first. */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:8098', trace: 'retain-on-failure' },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'node --disable-warning=ExperimentalWarning --import tsx src/server/main.ts',
    url: 'http://localhost:8098/api/health',
    reuseExistingServer: false,
    env: { LARDER_PORT: '8098', LARDER_STORAGE: 'memory', LARDER_AUTH: 'local', LARDER_WEB_DIR: 'dist/web', LARDER_LOG_LEVEL: 'warn', LARDER_DATA_DIR: 'test-results/data', LARDER_BACKUP_EVERY_HOURS: '0' },
  },
  workers: 1,
});
