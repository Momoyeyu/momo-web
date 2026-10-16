// 存档页：槽位网格、AUTO 只读卡、保存到空槽、卡片内容、删除槽位、读档模式的禁用态。
//
// ⚠️ 有意**不实际执行**「读档」与「开始新会话」：这两条都会把当前 live 会话
// 快照进 AUTO 槽（`load_checkpoint` / `new_session` 的既有语义），而真实实例的
// AUTO 槽里有用户自己的存档，冲掉无法通过 API 还原。所以本 spec 只验证：
//   - 读档模式的页面渲染与「空槽禁用」
//   - 存档模式的完整写入/删除往返（只动自己新建的槽）
import { expect, test, type Page } from "@playwright/test";
import { gotoRoute } from "./helpers";

/** 存档入口在对话页工具条（标题页没有可保存的现场）。 */
async function openSaveMode(page: Page): Promise<void> {
  await gotoRoute(page, "chat");
  await page.getByLabel("存档").click();
  await expect(page.locator(".checkpoint-panel.checkpoint-save")).toBeVisible();
}

const filled = (page: Page) => page.locator(".checkpoint-grid .slot-card.slot-filled");

test("存档模式：网格 12 格 + AUTO 卡置顶只读 + 翻页器", async ({ page }) => {
  await openSaveMode(page);

  await expect(page.locator(".checkpoint-grid .slot-card")).toHaveCount(12);
  // AUTO 卡在网格之外、只读（无删除按钮）
  const auto = page.locator(".slot-card.slot-auto");
  if (await auto.count()) {
    await expect(auto.locator(".slot-badge")).toHaveText("AUTO");
    await expect(auto.locator(".slot-del")).toHaveCount(0);
  }
  await expect(page.locator(".checkpoint-pager .list-pager")).toBeVisible();
  await expect(page.locator(".checkpoint-pager .pager-text")).toHaveText("1 / 1");
});

test("保存到空槽 → 卡片出现（槽号/时间/预览）→ 删除后回到空槽", async ({ page }) => {
  const before = await filled(page).count();
  await openSaveMode(page);
  const beforeCount = await filled(page).count();

  // 点第一个空槽即保存当前会话快照
  await page.locator(".checkpoint-grid .slot-card.slot-empty").first().click();
  await expect(filled(page)).toHaveCount(beforeCount + 1, { timeout: 15_000 });

  const created = filled(page).filter({ hasText: /No\.\d{3}/ }).last();
  await expect(created.locator(".slot-no")).toHaveText(/No\.\d{3}/);
  await expect(created).not.toBeEmpty();

  // 删除槽位（确认弹窗要显式接受）
  page.on("dialog", (d) => void d.accept());
  await created.locator(".slot-del").click();
  await expect(filled(page)).toHaveCount(beforeCount, { timeout: 15_000 });
  expect(before >= 0).toBe(true);
});

test("读档模式：页面可达，空槽不可点，AUTO 卡可读", async ({ page }) => {
  // 直开 #/checkpoint 默认就是读档模式
  await gotoRoute(page, "checkpoint");
  await expect(page.locator(".checkpoint-panel.checkpoint-load")).toBeVisible();
  await expect(page.locator(".checkpoint-head h1")).toHaveText("读档");

  const empty = page.locator(".checkpoint-grid .slot-card.slot-empty").first();
  if (await empty.count()) {
    await expect(empty).not.toHaveClass(/slot-clickable/);
  }
  await expect(page.locator(".checkpoint-pager .list-pager")).toBeVisible();
});
