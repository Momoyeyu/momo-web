// 对话页：真实 LLM 回合（后端切句并剥指令 → SSE sentence 事件 → 前端逐句上屏与落账）、
// backlog、控件态。
//
// ⚠️ 会真实写入 live 会话（这是 /api/chat 的固有行为）。用例只发**一条固定文案**，
// afterEach 用 /api/chat/interrupt 撤掉 assistant 行；user 行没有 API 可删，
// 故每跑一次会留在 live 里多一条 user（已知且可接受）。
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { gotoRoute } from "./helpers";

/** 固定文案：afterEach 要靠它定位并撤回。 */
const PROMPT = "只回复四个字：测试通过";

type LiveRow = { role: string; text: string };

async function liveRows(request: APIRequestContext): Promise<LiveRow[]> {
  const res = await request.get("/api/checkpoints/live");
  return ((await res.json()) as { messages: LiveRow[] }).messages;
}

test.afterEach(async ({ request }) => {
  // 撤回本轮 assistant（幂等：没有匹配的尾对时什么也不做）
  await request.post("/api/chat/interrupt", { data: { user: PROMPT, assistant: "" } });
});

test("控件态：输入为空时发送禁用，工具条与状态条齐备", async ({ page }) => {
  await gotoRoute(page, "chat");

  // 状态已并进对话框：与铭牌同排、不再是页面左上角的浮标
  await expect(page.locator(".dialog-box .nameplate-row .chat-status")).toHaveCount(1);
  await expect(page.locator(".chat-status")).toContainText("空闲");
  await expect(page.locator(".nameplate")).not.toBeEmpty();

  const send = page.locator(".input-row button").first();
  await expect(send).toBeDisabled();
  await page.locator(".input-row input").fill("x");
  await expect(send).toBeEnabled();
  await page.locator(".input-row input").fill("");

  const toolbar = await page.locator(".chat-toolbar .tb").allTextContents();
  expect(toolbar).toEqual(["记录", "存档", "读档", "语音·开", "设置", "返回标题"]);
});

test("真实回合：发送 → 逐句上屏 → 落账 → backlog 可见，且指令被剥离", async ({
  page,
  request,
}) => {
  await gotoRoute(page, "chat");
  const before = (await liveRows(request)).length;

  await page.locator(".input-row input").fill(PROMPT);
  await page.locator(".input-row button").first().click();

  // 后端落账是权威信号。注意回合是「先写 user 行，LLM 回来后再写 assistant 行」，
  // 所以不能只等条数变多——要等尾行变成 assistant。
  await expect
    .poll(
      async () => {
        const rows = await liveRows(request);
        return rows.length > before && rows[rows.length - 1].role === "assistant";
      },
      { timeout: 90_000 },
    )
    .toBe(true);

  // 字幕已上屏；<motion>/<exp> 指令由前端剥离，不应出现在字幕里
  await expect(page.locator(".subtitle")).not.toHaveText("……");
  await expect(page.locator(".subtitle")).not.toContainText("<motion>");
  await expect(page.locator(".chat-error")).toHaveCount(0);

  // 落账的 assistant 正文同样不含指令（backend 落库前剥离）
  const rows = await liveRows(request);
  const reply = rows[rows.length - 1];
  expect(reply.role).toBe("assistant");
  expect(reply.text).not.toContain("<motion>");
  expect(reply.text.length).toBeGreaterThan(0);

  // backlog 里能看到本轮 user 文案。
  // 用 .first()：同一文案在多次运行后会累积（user 行没有 API 可删），
  // 不加会撞 strict mode。
  await gotoRoute(page, "backlog");
  await expect(page.locator(".bl-item").filter({ hasText: PROMPT }).first()).toBeVisible();
});

test("backlog：历史条目按角色渲染，assistant 带回放按钮（句级：连续多条 assistant）", async ({ page }) => {
  await gotoRoute(page, "backlog");
  await expect(page.locator(".backlog-list")).toBeVisible();

  const rows = page.locator(".bl-item");
  if (await rows.count()) {
    await expect(rows.first()).toHaveClass(/user|assistant/);
    // assistant 条目应带回放控件（♪ 回放）
    const assistant = page.locator(".bl-item.assistant").first();
    if (await assistant.count()) {
      await expect(assistant.locator(".bl-replay")).toBeVisible();
    }
  }
});

test("离开对话页后回来，字幕保持（引擎跨页存活）", async ({ page }) => {
  await gotoRoute(page, "chat");
  const text = await page.locator(".subtitle").textContent();
  await gotoRoute(page, "settings");
  await gotoRoute(page, "chat");
  await expect(page.locator(".subtitle")).toHaveText(text ?? "");
});

/** 仅用于类型可见性：Page 在用例签名里被用到。 */
export type { Page };
