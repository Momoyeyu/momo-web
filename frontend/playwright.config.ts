import { defineConfig, devices } from "@playwright/test";

// E2E 直接跑在**你正在用的开发实例**上：vite :5173 → backend :7821。
// 不另起服务（避免重复 instance）；tts/asr/embedding 也走 mac-studio 上那套，
// 测试不碰它们。
//
// 因为打的是真实实例，所有会写状态的用例都必须**用完还原**：
//   - 配置（momo.yaml）：beforeEach 快照 /api/state，afterEach 原样 PUT 回去
//   - 数据（momo.db）：只做「建 → 断言 → 删」，不留残留
//
// 后端是单实例 + 单 SQLite 连接，故串行跑（workers: 1）。
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.MOMO_E2E_BASE_URL ?? "http://localhost:5173",
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
