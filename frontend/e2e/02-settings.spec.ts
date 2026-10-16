// 设置页：五 tab、i18n 即时生效、出厂默认值跟随对话语言、控件写盘、端点探测、拓展登记。
//
// 打的是真实实例，故：配置改动由 useStateRestore 整体快照还原；
// 拓展记录只做「建 → 断言 → 删」。
import { expect, test } from "@playwright/test";
import {
  fieldRow,
  openApp,
  openTab,
  pickSelect,
  readState,
  useStateRestore,
  waitSaved,
} from "./helpers";

const restore = useStateRestore();
test.afterEach(restore);

test("五个 tab 齐全，可逐个切换", async ({ page }) => {
  await openApp(page, "settings");
  expect(await page.locator(".stab-label").allTextContents()).toEqual([
    "通用",
    "模型",
    "人设",
    "记忆",
    "拓展",
  ]);

  const tabs: [string, string][] = [
    ["通用", ".settings-cols"],
    ["模型", ".settings-cols"],
    ["人设", ".persona-tab"],
    ["记忆", ".mem-panel"],
    ["拓展", ".ext-panel"],
  ];
  for (const [label, sel] of tabs) {
    await page.locator(".stab", { hasText: label }).click();
    await expect(page.locator(sel).first()).toBeVisible();
  }
});

test("界面语言即时生效，且写回后端", async ({ page, request }) => {
  await openTab(page, "通用");
  await pickSelect(page, "界面语言", "日本語");
  await waitSaved(page);

  await expect(page.locator(".stab-label").first()).toHaveText("一般");
  const state = await readState(request);
  expect((state.settings as { general: { lang: string } }).general.lang).toBe("ja");
});

test("人设出厂默认值跟随「对话语言」而非界面语言", async ({ page }) => {
  const identity = (p: typeof page) =>
    p
      .locator(".field")
      .filter({ has: p.getByText("身份", { exact: true }) })
      .locator("input");

  await openTab(page, "通用");
  await pickSelect(page, "对话语言", "日本語"); // 界面保持中文
  await waitSaved(page);

  await page.locator(".stab", { hasText: "人设" }).click();
  await expect(identity(page)).toHaveAttribute("placeholder", "夜羽が開発したAI");
  await expect(page.locator(".stab-label").first()).toHaveText("通用"); // 界面没跟着变

  await page.locator(".stab", { hasText: "通用" }).click();
  await pickSelect(page, "对话语言", "English");
  await waitSaved(page);
  await page.locator(".stab", { hasText: "人设" }).click();
  await expect(identity(page)).toHaveAttribute("placeholder", "an AI assistant");
});

test("滑块拖动即时反映数值并写盘", async ({ page, request }) => {
  await openTab(page, "通用");
  const field = fieldRow(page, "语音音量");
  await field.locator("input.ux-range").fill("42");
  await expect(field.locator(".slider-val")).toHaveText("42%");
  await waitSaved(page);

  const state = await readState(request);
  expect(
    (state.settings as { general: { voiceVolume: number } }).general.voiceVolume,
  ).toBe(42);
});

test("开关点击切换并写盘", async ({ page, request }) => {
  await openTab(page, "通用");
  const read = async () =>
    (await readState(request)).settings as { general: { showStatus: boolean } };
  const before = (await read()).general.showStatus;

  const sw = fieldRow(page, "显示对话状态").locator(".switch");
  await sw.click();
  await waitSaved(page);
  expect((await read()).general.showStatus).toBe(!before);
});

test("端点探测：可点、出结果、2.5s 后自动复原", async ({ page }) => {
  await openTab(page, "模型");
  const btn = page.locator(".probe-btn").first(); // 首行是 LLM
  await expect(btn).toHaveText("测试");
  await btn.click();
  await expect(btn).toHaveClass(/probe-ok|probe-err/, { timeout: 25_000 });
  await expect(btn).toHaveText("测试", { timeout: 10_000 });
});

test("拓展 tab：登记 stdio MCP server → 出现在列表 → 删除", async ({ page }) => {
  await openTab(page, "拓展");
  await expect(page.locator(".ext-list")).toBeVisible();

  await page.locator(".ext-add").click();
  await expect(page.locator(".modal-overlay")).toBeVisible();

  await fieldRow(page, "名称", ".ext-modal").locator("input").fill("e2e-echo");
  await pickSelect(page, "连接方式", "stdio", ".ext-modal");
  await fieldRow(page, "命令", ".ext-modal").locator("input").fill("echo");
  await page.locator(".ext-actions").getByText("保存").click();

  await expect(page.locator(".modal-overlay")).toBeHidden();
  const created = page.locator(".ext-row").filter({ hasText: "e2e-echo" });
  await expect(created).toBeVisible();

  // 用完即删（配置随后还会被 afterEach 整体还原）
  await created.locator(".danger").click();
  await expect(page.locator(".ext-row").filter({ hasText: "e2e-echo" })).toHaveCount(0);
});
