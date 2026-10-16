// 记忆面板：添加 / PIN / 检索 / 详情弹窗 / 编辑 / 删除 / 分页。
//
// 记忆存在 momo.db（真实实例），所以用例只做「建 → 断言 → 删」，
// 并在 afterEach 用 API 兜底清掉本轮造的数据。
import { expect, test, type APIRequestContext } from "@playwright/test";
import { openTab } from "./helpers";

const PREFIX = "e2e-";

/** 兜底清理：删掉所有 e2e- 前缀的记忆（幂等）。 */
async function purgeMemories(request: APIRequestContext): Promise<void> {
  const list = (await (await request.get("/api/memories")).json()) as {
    id: string;
    content: string;
  }[];
  for (const m of list) {
    if (m.content.startsWith(PREFIX)) await request.delete(`/api/memories/${m.id}`);
  }
}

/** 造一条记忆（走 UI，顺便验证添加弹窗）。 */
async function addViaUi(page: import("@playwright/test").Page, text: string): Promise<void> {
  await page.locator(".mem-toolbar .icon-btn").click();
  await expect(page.locator(".modal-overlay")).toBeVisible();
  await page.locator(".mem-add-text").fill(text);
  await page.locator(".modal-foot").getByText("保存").click();
  await expect(page.locator(".modal-overlay")).toBeHidden();
}

const card = (page: import("@playwright/test").Page, text: string) =>
  page.locator(".mem-panel .list-item").filter({ hasText: text });

test.beforeEach(async ({ request }) => {
  await purgeMemories(request); // 清掉上次跑剩的
});
test.afterEach(async ({ request }) => {
  await purgeMemories(request);
});

test("空态 → 添加 → 出现在列表 → 删除", async ({ page }) => {
  await openTab(page, "记忆");
  await expect(page.locator(".mem-panel")).toBeVisible();

  await addViaUi(page, `${PREFIX}喜欢吃草莓蛋糕`);
  await expect(card(page, `${PREFIX}喜欢吃草莓蛋糕`)).toBeVisible();

  // 删除走 window.confirm：Playwright 默认忽略弹窗（≈取消），必须显式接受，
  // 且要在点击之前注册。
  page.on("dialog", (d) => void d.accept());
  await card(page, `${PREFIX}喜欢吃草莓蛋糕`).getByText("删除").click();
  await expect(card(page, `${PREFIX}喜欢吃草莓蛋糕`)).toHaveCount(0);
});

test("PIN 图钉：切换后后端 pinned 变化", async ({ page, request }) => {
  await openTab(page, "记忆");
  await addViaUi(page, `${PREFIX}用户的名称是夜羽`);

  const item = card(page, `${PREFIX}用户的名称是夜羽`);
  const pin = item.locator(".mem-pinicon");
  await expect(pin).not.toHaveClass(/\bon\b/);
  await pin.click();

  await expect(pin).toHaveClass(/\bon\b/);
  await expect
    .poll(async () => {
      const list = (await (await request.get("/api/memories")).json()) as {
        content: string;
        pinned: boolean;
      }[];
      return list.find((m) => m.content.startsWith(PREFIX))?.pinned;
    })
    .toBe(true);
});

test("检索过滤命中集，空结果显示空态", async ({ page }) => {
  await openTab(page, "记忆");
  // 用唯一 token 做内容与检索词：真实库里已有「夜羽喜欢吃拉面」这类数据，
  // 拿普通词做子串过滤会撞上（strict mode violation）。
  const alpha = `${PREFIX}ALPHA-检索目标`;
  const beta = `${PREFIX}BETA-另一个目标`;
  await addViaUi(page, alpha);
  await addViaUi(page, beta);

  await page.locator(".mem-search").fill("ALPHA");
  await expect(card(page, alpha)).toBeVisible();
  await expect(card(page, beta)).toHaveCount(0);

  await page.locator(".mem-search").fill("不存在的关键词xyz");
  await expect(page.locator(".mem-panel .muted", { hasText: "没有匹配的记忆" })).toBeVisible();
});

test("点卡片开详情弹窗（只读全文），关闭后回到列表", async ({ page }) => {
  await openTab(page, "记忆");
  const text = `${PREFIX}上周末她提到想去河边散步，傍晚的风很舒服`;
  await addViaUi(page, text);

  await card(page, text).click();
  await expect(page.locator(".modal-overlay")).toBeVisible();
  await expect(page.locator(".modal-body")).toHaveText(text);
  await page.locator(".modal-foot").getByText("关闭").click();
  await expect(page.locator(".modal-overlay")).toBeHidden();
  await expect(card(page, text)).toBeVisible();
});

test("卡片内联编辑：改内容后列表与后端都更新", async ({ page, request }) => {
  await openTab(page, "记忆");
  await addViaUi(page, `${PREFIX}旧事实`);

  await card(page, `${PREFIX}旧事实`).getByText("编辑").click();

  // 进入编辑态后内容在 <textarea> 里，不再是文本内容，
  // 按 hasText 定位的卡片会失效——改用「含有 .list-edit 的那张卡」定位。
  const editing = page
    .locator(".mem-panel .list-item")
    .filter({ has: page.locator(".list-edit") });
  await editing.locator("textarea").fill(`${PREFIX}新事实`);
  await editing.getByText("保存").click();

  await expect(card(page, `${PREFIX}新事实`)).toBeVisible();
  const list = (await (await request.get("/api/memories")).json()) as { content: string }[];
  expect(list.some((m) => m.content === `${PREFIX}新事实`)).toBe(true);
});

test("分页器始终渲染（单页也显示 1/1）", async ({ page }) => {
  await openTab(page, "记忆");
  await expect(page.locator(".mem-panel .list-pager .pager-text")).toHaveText("1 / 1");
});
