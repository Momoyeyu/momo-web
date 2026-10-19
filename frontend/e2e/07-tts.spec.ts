// TTS 合成语言：必须跟随「通用」页的**对话语言**（chatLang），
// 而不是界面语言、也不是 TTS 自己的字段。
//
// 走 backlog 的「回放」路径验证：它和实时回合共用同一处语言解析，
// 是对这个需求最干净的观测点。
// 拦下 /api/tts/speech（后端代理）读请求体，不依赖真实的 GPT-SoVITS。
import { expect, test } from "@playwright/test";
import { gotoRoute, readState, useStateRestore, writeState } from "./helpers";

const restore = useStateRestore();

// 本用例要先自己造一个可回放的回合，收尾时把它的 assistant 行撤掉（幂等）。
const PROMPT = "只回复两个字：收到";
test.afterEach(async ({ request }) => {
  await request.post("/api/chat/interrupt", {
    data: { user: PROMPT, assistant: "" },
  });
  await restore({ request });
});

type Body = { input?: string; lang?: string; voice?: string };

test("TTS 请求的 lang = 对话语言（日语/英语/auto 三种）", async ({ page, request }) => {
  const bodies: Body[] = [];
  await page.route("**/api/tts/speech", async (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? "{}") as Body);
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "audio/pcm", "X-Sample-Rate": "32000" },
      body: "",
    });
  });

  // 先自己造一个回合：不能依赖别的 spec 留下的数据 —— 06-chat 的收尾会把它自己的
  // assistant 行撤掉，排在它后面就必然找不到可回放条目（假失败）。
  await gotoRoute(page, "chat");
  await page.locator(".input-row input").fill(PROMPT);
  await page.getByLabel("发送").click();

  // 回合跑完（按钮可点）再断言；期间句子逐条落库，故这里等到的是真实持久化结果
  await gotoRoute(page, "backlog");
  await expect(page.locator(".bl-replay:not([disabled])").first()).toBeVisible({
    timeout: 30_000,
  });

  // auto 的期望值 = 界面语言（useStateRestore 已把 lang 固定为 zh）
  const cases: [string, string][] = [
    ["ja", "ja"],
    ["en", "en"],
    ["auto", "zh"],
  ];

  for (const [chatLang, want] of cases) {
    const state = await readState(request);
    (state.settings as { general: { chatLang: string } }).general.chatLang = chatLang;
    // 参考音频随便给个文件名：请求被 page.route 拦下，不会真的到 backend
    const tts = (state.settings as { tts: { url: string; voice: string } }).tts;
    tts.url = tts.url || "http://tts.test";
    tts.voice = "ref.wav";
    await writeState(request, state);

    await page.reload(); // 重新 boot 才能让 store 读到新配置
    await page.waitForTimeout(900); // bootPersist 是异步的，等它把远端配置合并进来
    await page.waitForTimeout(900); // bootPersist 是异步的，等它把远端配置合并进来
    await expect(page.locator(".bl-replay:not([disabled])").first()).toBeVisible();

    bodies.length = 0;
    await page.locator(".bl-replay:not([disabled])").first().click();
    await expect
      .poll(() => bodies.length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    expect(bodies.at(-1)?.lang, `chatLang=${chatLang} 时 TTS lang 应为 ${want}`).toBe(want);
    expect(bodies.at(-1)?.input).toBeTruthy();
  }
});
