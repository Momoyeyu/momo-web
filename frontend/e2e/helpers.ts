// E2E 公共工具：路由跳转、配置快照/还原、定位器辅助。
//
// 测试必须打显式 MOMO_E2E_BASE_URL 隔离实例；配置快照仅用于测试间还原。
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/** 应用外壳（四条路由各自的根容器）。 */
const SHELL = ".title-screen, .chat-page, .settings-page, .backlog-page";

/**
 * 打开某条路由。
 *
 * 必须用 page.goto：Playwright 每个用例都是全新页面，只改 hash 在
 * about:blank 上不会导航。应用是「先拉 backend state 再渲染」，
 * 所以还要等外壳出现。
 */
export async function gotoRoute(page: Page, route = "title"): Promise<void> {
  await page.goto(`/#/${route}`);
  await expect(page.locator(SHELL).first()).toBeVisible();
  // A mounted shell can still be behind startup or a scene/dialogue entrance.
  // Functional tests type only once real players can interact with that shell.
  await expect.poll(() => page.locator(SHELL).first().evaluate(element => !element.closest('[inert]'))).toBe(true);
}

/** 兼容旧名。 */
export const openApp = gotoRoute;

/** Chat mounts before its scene/dialogue entry releases keyboard input. */
export async function waitForChatReady(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.chat-page').evaluate(element => !element.closest('[inert]'))).toBe(true);
}

/** 进设置页的某个 tab（tab 名按当前界面语言取，调用方给 zh 字面量即可）。 */
export async function openTab(page: Page, label: string): Promise<void> {
  await gotoRoute(page, "settings");
  await page.locator(".stab", { hasText: label }).click();
}

/** 收集控制台错误与未捕获异常，供「无错误」断言使用。 */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

// ---------------- 配置快照 / 还原（momo.yaml） ----------------

type State = Record<string, unknown>;

/** 直连 backend 读整份配置（走 vite 代理，与页面同源）。 */
export async function readState(request: APIRequestContext): Promise<State> {
  return (await request.get("/api/state")).json();
}

/** 整体写回配置。 */
export async function writeState(request: APIRequestContext, state: State): Promise<void> {
  const res = await request.put("/api/state", { data: state });
  expect(res.status()).toBe(204);
}

/**
 * 给一组用例装上「配置快照 + 自动还原」，并把界面语言固定为 zh。
 *
 * 真实配置的界面语言可能是 ja（用例里的选择器都按中文写），所以先把
 * general.lang 拨到 zh 保证确定性，跑完连同其它改动一起还原。
 */
export function useStateRestore(): (args: { request: APIRequestContext }) => Promise<void> {
  let snap: State | null = null;
  test.beforeEach(async ({ request }) => {
    snap = await readState(request);
    const general = (snap.settings as { general?: Record<string, unknown> })?.general;
    if (general && general.lang !== "zh") {
      general.lang = "zh";
      await writeState(request, snap);
    }
  });
  return async ({ request }) => {
    if (snap) await writeState(request, snap);
  };
}

/** 等防抖 PUT 落盘（store 的 remoteSave 是 300ms 防抖）。 */
export async function waitSaved(page: Page, ms = 600): Promise<void> {
  await page.waitForTimeout(ms);
}

// ---------------- 定位器 ----------------

/**
 * 按左标签定位行式表单项。
 *
 * 用子串匹配而非精确匹配：必填项的标签元素文本会带上 `*`
 * （`<span class="opt-label">名称<span class="req">*</span></span>`）。
 * 调用方传完整标签即可避免「界面语言 / 对话语言」这类前缀撞车。
 *
 * 注意：`filter({ has })` 的内层定位器会被**重新挂到每个候选元素下**，
 * 所以内层只能写相对路径（`.opt-label`），scope 只加在外层。
 */
/**
 * 等页面转场结束：转场期间旧页仍挂在栈里（.page-wrap.is-leaving），
 * 会让严格定位器同时匹配到新旧两份 DOM。断言前先等它收场。
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !document.querySelector(".app-stage.tx-active, .page-wrap.is-leaving"),
    undefined,
    { timeout: 5_000 },
  );
}

/** 当前激活的设置面板（四个 tab 常驻横排，其余 pane 带 aria-hidden）。 */
export const activePane = (page: Page) =>
  page.locator(".settings-pane:not([aria-hidden])");

export const fieldRow = (page: Page, label: string, scope = "") =>
  page
    .locator(`${scope} .opt-row`.trim())
    .filter({ has: page.locator(".opt-label", { hasText: label }) });

/** 自绘下拉：点值框开列，再点选项。 */
export async function pickSelect(
  page: Page,
  label: string,
  option: string,
  scope = "",
): Promise<void> {
  await fieldRow(page, label, scope).locator(".sel-face").click();
  await page.locator(".sel-opt").filter({ hasText: option }).first().click();
}

// Every spec targets isolated data. Release its real meeting before the next
// browser document, without taking over another window or waiting for TTL.
test.afterEach(async ({page}) => {
  if (page.isClosed()) return;
  await page.evaluate(async () => {
    const resource=performance.getEntriesByType('resource').find(entry=>new URL(entry.name).pathname==='/src/services/meetingClient.ts');
    if (resource) await (await import(resource.name)).leaveMeeting();
  }).catch(()=>{});
});
