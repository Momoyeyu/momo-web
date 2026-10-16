// 人设面板：基本信息写盘、偏好卡片（增 / 编辑 / 详情弹窗 / 删）。
//
// persona 存在 momo.yaml，配置改动由 useStateRestore 整体还原，故无需手工清理。
import { expect, test } from "@playwright/test";
import { openTab, readState, useStateRestore, waitSaved } from "./helpers";

const restore = useStateRestore();
test.afterEach(restore);

const TAG = "e2e偏好";

/** 人设「基本信息」用的是 .field / .field-label（与设置页行式表单项不同）。 */
const personaField = (page: import("@playwright/test").Page, label: string) =>
  page
    .locator(".persona-tab .field")
    .filter({ has: page.locator(".field-label", { hasText: label }) });

const prefCard = (page: import("@playwright/test").Page, text: string) =>
  page.locator(".persona-section .list-item").filter({ hasText: text });

test("基本信息：改名称即写盘", async ({ page, request }) => {
  await openTab(page, "人设");
  const name = personaField(page, "名称").locator("input");
  await name.fill("momo-e2e");
  await waitSaved(page);

  const state = await readState(request);
  expect((state.persona as { name: string }).name).toBe("momo-e2e");
});

test("偏好：添加 → 出现在列表 → 编辑 → 详情弹窗 → 删除", async ({ page, request }) => {
  await openTab(page, "人设");
  const original = ((await readState(request)).persona as { preferences: string[] })
    .preferences.length;

  // 添加：IconButton 追加空条目并直接进入编辑态
  await page.locator(".persona-section .mem-toolbar .icon-btn").click();
  const editing = page
    .locator(".persona-section .list-item")
    .filter({ has: page.locator(".list-edit") });
  await editing.locator("input").fill(`${TAG}喜欢苏打水`);
  await editing.getByText("保存").click();

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
  await prefCard(page, `${TAG}喜欢苏打水`).getByText("编辑").click();
  const editBox = page
    .locator(".persona-section .list-item")
    .filter({ has: page.locator(".list-edit") });
  await editBox.locator("input").fill(`${TAG}喜欢气泡水`);
  await editBox.getByText("保存").click();
  await expect(prefCard(page, `${TAG}喜欢气泡水`)).toBeVisible();

  // 删除（偏好删除无确认弹窗）
  await prefCard(page, `${TAG}喜欢气泡水`).getByText("删除").click();
  await expect(prefCard(page, `${TAG}喜欢气泡水`)).toHaveCount(0);
  await waitSaved(page);

  const final = await readState(request);
  expect((final.persona as { preferences: string[] }).preferences.length).toBe(original);
});

test("偏好编辑态取消：新增的空条目被撤掉，数量回到原值", async ({ page, request }) => {
  await openTab(page, "人设");
  const original = ((await readState(request)).persona as { preferences: string[] })
    .preferences.length;

  await page.locator(".persona-section .mem-toolbar .icon-btn").click();
  const editing = page
    .locator(".persona-section .list-item")
    .filter({ has: page.locator(".list-edit") });
  await editing.getByText("取消").click();
  await waitSaved(page);

  const after = await readState(request);
  expect((after.persona as { preferences: string[] }).preferences.length).toBe(original);
});
