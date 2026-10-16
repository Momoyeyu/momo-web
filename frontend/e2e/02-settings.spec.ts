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
    "形象",
    "记忆",
    "拓展",
  ]);

  const tabs: [string, string][] = [
    ["通用", ".settings-cols"],
    ["模型", ".settings-cols"],
    ["形象", ".persona-tab"],
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

test("形象 tab 的出厂默认值跟随「对话语言」而非界面语言", async ({ page }) => {
  const identity = (p: typeof page) =>
    p
      .locator(".field")
      .filter({ has: p.getByText("身份", { exact: true }) })
      .locator("input");

  await openTab(page, "通用");
  await pickSelect(page, "对话语言", "日本語"); // 界面保持中文
  await waitSaved(page);

  await page.locator(".stab", { hasText: "形象" }).click();
  await expect(identity(page)).toHaveAttribute("placeholder", "夜羽が開発したAI");
  await expect(page.locator(".stab-label").first()).toHaveText("通用"); // 界面没跟着变

  await page.locator(".stab", { hasText: "通用" }).click();
  await pickSelect(page, "对话语言", "English");
  await waitSaved(page);
  await page.locator(".stab", { hasText: "形象" }).click();
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

test("通用 tab：语言/语音各成一框，语义检索开关已移除", async ({ page }) => {
  await openTab(page, "通用");

  // 左栏两个子框，标题按顺序
  const subs = await page.locator(".settings-cols .opt-sub .opt-group").allTextContents();
  expect(subs).toEqual(["语言设置", "语音设置"]);

  // 语义检索不再有开关（改为按 embedding 是否配置自动判定，后端有单测钉住）
  await expect(page.getByText("语义检索", { exact: true })).toHaveCount(0);

  // 「显示对话状态」归入右栏「对话框设置」组
  const dialogPanel = page.locator(".settings-col").filter({ hasText: "对话框设置" });
  await expect(
    dialogPanel.locator(".opt-label").filter({ hasText: "显示对话状态" }),
  ).toBeVisible();
});

test("形象 tab：偏好与 Live2D 模型左右并排且等宽", async ({ page }) => {
  await openTab(page, "形象");

  const cols = page.locator(".persona-tab > .settings-cols > .persona-section");
  await expect(cols).toHaveCount(2);
  await expect(cols.nth(0)).toContainText("偏好");
  await expect(cols.nth(1)).toContainText("Live2D 模型");

  // 等宽（对齐要求）：两栏宽度之差 < 2px
  const [a, b] = await Promise.all([
    cols.nth(0).boundingBox(),
    cols.nth(1).boundingBox(),
  ]);
  expect(Math.abs((a?.width ?? 0) - (b?.width ?? 0))).toBeLessThan(2);

  // 形象面板已从「模型」tab 移走
  await page.locator(".stab", { hasText: "模型" }).click();
  await expect(page.locator(".ext-panel, .settings-cols")).toBeVisible();
  await expect(page.getByText("Live2D 模型", { exact: true })).toHaveCount(0);
});

test("探测按钮与同列「显示」按钮同宽，结果态不裁字", async ({ page }) => {
  await openTab(page, "模型");
  const probe = page.locator(".probe-btn").first();
  const toggle = page.locator(".key-toggle:not(.probe-btn)").first();

  const idle = await probe.boundingBox();
  const show = await toggle.boundingBox();
  expect(Math.abs((idle?.width ?? 0) - (show?.width ?? 0))).toBeLessThan(2);

  await probe.click();
  await expect(probe).toHaveClass(/probe-ok|probe-err/, { timeout: 25_000 });

  // 结果态：文字宽（Range 实测）不超过按钮可用宽，且整体仍在合理区间
  const m = await probe.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return {
      text: range.getBoundingClientRect().width,
      client: el.clientWidth,
      box: el.getBoundingClientRect().width,
    };
  });
  expect(m.text).toBeLessThanOrEqual(m.client + 0.5);
  expect(m.box).toBeGreaterThanOrEqual(51);
  expect(m.box).toBeLessThan(90);

  await expect(probe).toHaveText("测试", { timeout: 10_000 });
});

test("形象 tab：与「偏好」同构（检索 + 加号 + 翻页），加号开导入弹窗", async ({
  page,
}) => {
  await openTab(page, "形象");
  const panel = page.locator(".persona-section").nth(2);

  await expect(panel.locator(".mem-search")).toBeVisible();
  await expect(panel.locator(".icon-btn")).toBeVisible();
  await expect(panel.locator(".list-pager")).toBeVisible();
  await expect(panel.locator(".list-item").first()).toBeVisible();

  await panel.locator(".icon-btn").click();
  await expect(page.locator(".modal-overlay")).toBeVisible();
  await expect(page.locator(".modal-meta")).toHaveText("导入模型 (.zip)");
  await expect(page.locator(".modal-foot button").first()).toHaveText("选择 zip 文件");

  await page.locator(".modal-foot").getByText("取消").click();
  await expect(page.locator(".modal-overlay")).toBeHidden();
});

test("形象 tab：点模型卡片弹出「表情与动作」，并可按名检索", async ({ page }) => {
  await openTab(page, "形象");
  const panel = page.locator(".persona-section").nth(2);

  // 检索过滤（内置 Hiyori 命中，乱词落空态）
  await panel.locator(".mem-search").fill("Hiyori");
  await expect(panel.locator(".list-item").first()).toBeVisible();
  await panel.locator(".mem-search").fill("no-such-model-xyz");
  await expect(panel.locator(".muted", { hasText: "没有匹配的模型" })).toBeVisible();
  await panel.locator(".mem-search").fill("");

  // 点卡片 → 弹窗里是该模型的清单，描述可编辑
  await panel.locator(".list-item").first().click();
  await expect(page.locator(".modal-meta")).toContainText("表情与动作");
  const row = page.locator(".res-row").first();
  await expect(row).toBeVisible();
  const desc = row.locator("input");
  const before = await desc.inputValue();
  await desc.fill("e2e-描述");
  await expect(desc).toHaveValue("e2e-描述");
  await desc.fill(before); // 还原

  await page.locator(".modal-foot").getByText("关闭").click();
  await expect(page.locator(".modal-overlay")).toBeHidden();
});
