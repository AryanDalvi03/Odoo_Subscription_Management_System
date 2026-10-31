import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  globalTeardown: './tests/e2e/teardown.ts',
  use: { baseURL: 'http://127.0.0.1:5180', trace: 'retain-on-failure', actionTimeout: 15000 },
  webServer: [
    {
      command: 'npx tsx tests/e2e/server.ts',
      url: 'http://127.0.0.1:4100/api/health/live',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'npm run dev -w @subscriptiq/web',
      url: 'http://127.0.0.1:5180',
      env: { WEB_PORT: '5180', API_PROXY_URL: 'http://127.0.0.1:4100' },
      reuseExistingServer: false,
    },
  ],
});
