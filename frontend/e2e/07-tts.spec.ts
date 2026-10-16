// TTS 合成语言：必须跟随「通用」页的**对话语言**（chatLang），
// 而不是界面语言、也不是 TTS 自己的字段。
//
// 走 backlog 的「回放」路径验证：它和实时回合共用同一处语言解析，
// 但不发 /api/chat、不写 live，是对这个需求最干净的观测点。
// 拦下 /v1/audio/speech 读请求体，不依赖 mac-studio 上真实的 TTS。
import { expect, test } from "@playwright/test";
import { gotoRoute, readState, useStateRestore, writeState } from "./helpers";

const restore = useStateRestore();
test.afterEach(restore);

type Body = { input?: string; lang?: string; voice?: string };

test("TTS 请求的 lang = 对话语言（日语/英语/auto 三种）", async ({ page, request }) => {
  const bodies: Body[] = [];
  await page.route("**/v1/audio/speech", async (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? "{}") as Body);
    await route.fulfill({ status: 200, headers: { "Content-Type": "audio/pcm" }, body: "" });
  });

  await gotoRoute(page, "backlog");
  await expect(page.locator(".bl-replay:not([disabled])").first()).toBeVisible();

  // auto 的期望值 = 界面语言（useStateRestore 已把 lang 固定为 zh）
  const cases: [string, string][] = [
    ["ja", "ja"],
    ["en", "en"],
    ["auto", "zh"],
  ];

  for (const [chatLang, want] of cases) {
    const state = await readState(request);
    (state.settings as { general: { chatLang: string } }).general.chatLang = chatLang;
    await writeState(request, state);

    await page.reload(); // 重新 boot 才能让 store 读到新配置
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
