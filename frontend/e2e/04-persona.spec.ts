// 形象面板：基本信息写盘、偏好卡片（增 / 编辑 / 详情弹窗 / 删）。
//
// persona 存在 momo.yaml，配置改动由 useStateRestore 整体还原，故无需手工清理。
import { expect, test } from "@playwright/test";
import { openTab, readState, useStateRestore, waitSaved } from "./helpers";

const restore = useStateRestore();
test.afterEach(restore);

const TAG = "e2e偏好";

/** 形象页「基本信息」用的是 .field / .field-label（与设置页行式表单项不同）。 */
const personaField = (page: import("@playwright/test").Page, label: string) =>
  page
    .locator(".persona-tab .field")
    .filter({ has: page.locator(".field-label", { hasText: label }) });

/** 偏好面板：.persona-section 依次是 基本信息 / 偏好 / Live2D 模型，取第 2 块。 */
const prefPanel = (page: import("@playwright/test").Page) =>
  page.locator(".persona-section").nth(1);

const prefCard = (page: import("@playwright/test").Page, text: string) =>
  prefPanel(page).locator(".list-item").filter({ hasText: text });

test("基本信息：改名称即写盘", async ({ page, request }) => {
  await openTab(page, "形象");
  const name = personaField(page, "名称").locator("input");
  await name.fill("momo-e2e");
  await waitSaved(page);

  const state = await readState(request);
  expect((state.persona as { name: string }).name).toBe("momo-e2e");
});

test("偏好：添加 → 出现在列表 → 编辑 → 详情弹窗 → 删除", async ({ page, request }) => {
  await openTab(page, "形象");
  const original = ((await readState(request)).persona as { preferences: string[] })
    .preferences.length;

  // 添加：走弹窗（与工具栏「+」软绑定；不再用「追加空条目 + 进编辑态」）
  await prefPanel(page).locator(".mem-toolbar .icon-btn").click();
  await page.locator(".add-modal .add-field").fill(`${TAG}喜欢苏打水`);
  await page.locator(".modal-foot").getByText("保存").click();
  await expect(page.locator(".modal-overlay")).toBeHidden();

  await expect(prefCard(page, `${TAG}喜欢苏打水`)).toBeVisible();
  await waitSaved(page); // store 的 remoteSave 有 300ms 防抖，先等落盘再断言后端
  const after = await readState(request);
  expect((after.persona as { preferences: string[] }).preferences).toContain(
    `${TAG}喜欢苏打水`,
  );

  // 详情弹窗（点卡片）
  await prefCard(page, `${TAG}喜欢苏打水`).click();
  await expect(page.locator(".modal-body")).toHaveText(`${TAG}喜欢苏打水`);
  await page.locator(".modal-foot").getByText("关闭").click();
  await expect(page.locator(".modal-overlay")).toBeHidden();

  // 内联编辑：改内容
  await prefCard(page, `${TAG}喜欢苏打水`).getByLabel("编辑").click();
  const editBox = page
    .locator(".list-item")
    .filter({ has: page.locator(".list-edit") });
  await editBox.locator("input").fill(`${TAG}喜欢气泡水`);
  await editBox.getByText("保存").click();
  await expect(prefCard(page, `${TAG}喜欢气泡水`)).toBeVisible();

  // 删除（偏好删除无确认弹窗）
  await prefCard(page, `${TAG}喜欢气泡水`).getByLabel("删除").click();
  await expect(prefCard(page, `${TAG}喜欢气泡水`)).toHaveCount(0);
  await waitSaved(page);

  const final = await readState(request);
  expect((final.persona as { preferences: string[] }).preferences.length).toBe(original);
});

test("添加弹窗取消：不产生任何条目", async ({ page, request }) => {
  await openTab(page, "形象");
  const original = ((await readState(request)).persona as { preferences: string[] })
    .preferences.length;

  await prefPanel(page).locator(".mem-toolbar .icon-btn").click();
  await page.locator(".add-modal .add-field").fill(`${TAG}不该存在`);
  await page.locator(".modal-foot").getByText("取消").click();
  await expect(page.locator(".modal-overlay")).toBeHidden();
  await waitSaved(page);

  const after = await readState(request);
  const prefs = (after.persona as { preferences: string[] }).preferences;
  expect(prefs.length).toBe(original);
  // 取消要真的不落盘，而不只是数量对上
  expect(prefs).not.toContain(`${TAG}不该存在`);
});
