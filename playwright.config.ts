import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir: './tests/e2e', workers: 1, timeout: 45000,
 use: { baseURL: 'http://localhost:3000', launchOptions: { ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] } },
});
