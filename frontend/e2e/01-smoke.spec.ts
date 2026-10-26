// 冒烟：应用能起来、路由能走、控制台干净。
// 真实实例的界面语言可能是 ja，用 useStateRestore 先固定为 zh（跑完还原）。
import { expect, test } from "./fixtures";
import { collectErrors, gotoRoute, openApp, useStateRestore } from "./helpers";

const restore = useStateRestore();
test.afterEach(restore);

test("标题页：品牌 + tagline + 见面与设置菜单 + 星云背景", async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page, "title");

  await expect(page.locator(".title-logo")).toHaveAccessibleName("momo");
  await expect(page.locator(".title-tagline")).not.toBeEmpty();
  await expect(page.locator(".menu-item")).toHaveCount(2);
  await expect(page.locator(".ecg-canvas")).toHaveCount(1);
  expect(await page.locator(".mi-label").allTextContents()).toEqual([
    "启动",
    "设置",
  ]);

  expect(errors, `控制台错误：${errors.join(" | ")}`).toHaveLength(0);
});

test("四条路由都能渲染出各自的页面骨架", async ({ page }) => {
  await openApp(page, "title");

  const routes: [string, string][] = [
    ["settings", ".settings-page"],
    ["chat", ".chat-page"],
    ["backlog", ".backlog-page"],
    ["title", ".title-screen"],
  ];
  for (const [route, sel] of routes) {
    await gotoRoute(page, route);
    await expect(page.locator(sel).first()).toBeVisible();
  }
});

test("标题页「设置」进设置页，「返回标题」回得去", async ({ page }) => {
  await openApp(page, "title");
  await page.locator(".menu-item", { hasText: "设置" }).click();
  await expect(page.locator(".settings-page")).toBeVisible();

  await page.locator(".footbar button").click();
  await expect(page.locator(".title-screen")).toBeVisible();
});

test("Live2D 画布已挂载（使用随应用提供的 Cubism Core）", async ({ page }) => {
  await openApp(page, "title");
  const canvas = page.locator("div canvas").first();
  await expect(canvas).toBeAttached();
  expect((await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(100);
});
