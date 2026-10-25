import { defineConfig, devices } from "@playwright/test";

// Browser regressions may mutate sessions/configuration. An explicit isolated
// instance is required; never silently target the player's development service.
const isolatedBase = process.env.MOMO_E2E_BASE_URL;
if (!isolatedBase) throw new Error("Set MOMO_E2E_BASE_URL to an isolated test instance; see e2e/README.md");
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: isolatedBase,
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
