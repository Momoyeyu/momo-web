// TTS 合成语言：必须跟随「通用」页的**对话语言**（chatLang），
// 而不是界面语言、也不是 TTS 自己的字段。
//
// 走 backlog 的「回放」路径验证：它和实时回合共用同一处语言解析，
// 是对这个需求最干净的观测点。
// 拦下 /api/tts/speech（后端代理）读请求体，不依赖真实的 GPT-SoVITS。
import { expect, test } from "./fixtures";
import { gotoRoute, readState, useStateRestore, writeState } from "./helpers";

const restore = useStateRestore();

// 在隔离生活中创建可回放的真实展示记录；不回滚账本。
const PROMPT = "只回复两个字：收到";
test.afterEach(restore);

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

  const initial = await readState(request);
  (initial.settings as {tts: {url:string; voice:string}}).tts = {url:'http://tts.test', voice:'ref.wav'};
  await writeState(request, initial);

  // 自己创建已实际展示的回合，不依赖其他 spec 的记录。
  await gotoRoute(page, "chat");
  await page.locator(".input-row input").fill(PROMPT);
  await page.getByLabel("发送").click();
  await expect(page.getByLabel("发送",{exact:true})).toBeVisible();

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
