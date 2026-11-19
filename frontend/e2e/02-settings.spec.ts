// 设置页：四 tab、i18n 即时生效、控件写盘、端点探测、拓展登记、Live2D 面板。
//
// 打的是真实实例，故：配置改动由 useStateRestore 整体快照还原；
// 拓展记录只做「建 → 断言 → 删」。
import { expect, test } from "./fixtures";
import {
  fieldRow,
  openApp,
  openTab,
  openExtensionTab,
  pickSelect,
  readState,
  useStateRestore,
  waitSaved,
  writeState,
} from "./helpers";

const restore = useStateRestore();
test.afterEach(restore);

test("目录的十章与正文顺序一致，最后一章可以定位到阅读线", async ({ page }) => {
  await openApp(page, "settings");
  const index = page.locator(".config-index button");
  expect(await index.allTextContents()).toEqual(await page.locator(".config-scroll h2").allTextContents());
  await expect(index).toHaveCount(10);
  for (const link of await index.all()) {
    await link.click();
    await expect(link).toHaveAttribute("aria-current", "location");
  }
  await expect.poll(() => page.locator('#config-mods').evaluate(el =>
    Math.abs(el.getBoundingClientRect().top - el.parentElement!.getBoundingClientRect().top - 24))).toBeLessThan(2);
});

test("界面语言即时生效，且写回后端", async ({ page, request }) => {
  await openTab(page, "语言");
  await pickSelect(page, "界面语言", "日本語");
  await waitSaved(page);

  await expect(page.locator(".config-index button").first()).toHaveText("言語");
  const state = await readState(request);
  expect((state.settings as { general: { lang: string } }).general.lang).toBe("ja");
});

test("滑块拖动即时反映数值并写盘", async ({ page, request }) => {
  // 音量滑杆受 TTS 可用性门控：先配好 url 与参考音频，否则它是禁用的
  const st = await readState(request);
  const tts = (st.settings as { tts: { url: string; voice: string } }).tts;
  tts.url = "http://tts.test";
  tts.voice = "ref.wav";
  await writeState(request, st);
  await page.reload();
  await openTab(page, "语言");
  await openTab(page, "声音");
  const field = fieldRow(page, "语音音量");
  await field.locator("input.ux-range").fill("42");
  await expect(field.locator(".slider-val")).toHaveText("42%");
  await waitSaved(page);

  const state = await readState(request);
  expect(
    (state.settings as { general: { voiceVolume: number } }).general.voiceVolume,
  ).toBe(42);
});

test("开关点击切换并写盘", async ({ page, request }) => {
  await openTab(page, "语言");
  await openTab(page, "显示");
  const read = async () =>
    (await readState(request)).settings as { general: { showStatus: boolean } };
  const sw = fieldRow(page, "显示对话状态").locator(".switch");
  // 起点取界面实际状态：本开关另有用例也在动它，硬编码 true/false 会跨次跑互相污染
  await expect(sw).toHaveAttribute("aria-checked", /true|false/);
  const before = (await sw.getAttribute("aria-checked")) === "true";

  await sw.click();
  await waitSaved(page);
  expect((await read()).general.showStatus).toBe(!before);
});

test("端点探测：可点、出结果、2.5s 后自动复原", async ({ page }) => {
  await openTab(page, "模型");
  await page.getByRole("button", {name: "配置模型"}).click();
  const btn = page.locator(".probe-btn").first(); // 首行是 LLM
  await expect(btn).toHaveText("测试");
  await btn.click();
  await expect(btn).toHaveClass(/probe-ok|probe-err/, { timeout: 25_000 });
  await expect(btn).toHaveText("测试", { timeout: 10_000 });
});

test("设置弹窗：登记 stdio MCP server → 出现在列表 → 删除", async ({ page }) => {
  await openExtensionTab(page, "MCP");
  // 「说明书」性质的说明收进了问号浮窗：正文里不该再有那段长句，
  // 但说明本身要能在浮窗里拿到（鼠标走 data-tip，读屏走 aria-label）。
  // 直接查内容而不是类名：以后就算换了类名，只要长句又排回版面上就会红
  await expect(page.locator(".ext-panel")).not.toContainText("下一轮对话起");
  const hint = page.locator(".ext-panel .hint").first();
  await expect(hint).toHaveAttribute("data-tip", /MCP/);
  await expect(hint).toHaveAttribute("aria-label", /MCP/);
  await expect(page.locator(".ext-panel .list-body")).toBeVisible();

  await page.locator(".ext-panel .list-toolbar .icon-btn").click();
  await expect(page.locator(".modal-box:not(.config-modal)")).toBeVisible();

  await fieldRow(page, "名称", ".ext-modal").locator("input").fill("e2e-echo");
  await pickSelect(page, "连接方式", "stdio", ".ext-modal");
  await fieldRow(page, "命令", ".ext-modal").locator("input").fill("echo");
  await page.locator(".ext-actions").getByText("保存").click();

  await expect(page.locator(".modal-box:not(.config-modal)")).toBeHidden();
  const created = page.locator(".ext-row").filter({ hasText: "e2e-echo" });
  await expect(created).toBeVisible();

  // 用完即删（配置随后还会被 afterEach 整体还原）
  await created.locator(".danger").click();
  await expect(page.locator(".ext-row").filter({ hasText: "e2e-echo" })).toHaveCount(0);
});

test('adapter permission policy survives JSON import, metadata edit and document reload',async({page,request})=>{
  await openExtensionTab(page,'MCP');
  await page.locator('.ext-panel .list-toolbar .icon-btn').click();
  await page.locator('.ext-modal-head').getByRole('button',{name:'⇩ 从 JSON 填入',exact:true}).click();
  const policy={declaredPermissions:['mcp.tools','activities.game'],grantedPermissions:['mcp.tools','activities.game']};
  await page.locator('.ext-json textarea').fill(JSON.stringify({name:'e2e-scoped-game',command:'echo',enabled:false,...policy}));
  await page.locator('.ext-json-ops').getByRole('button',{name:'填入',exact:true}).click();
  await page.locator('.ext-actions').getByText('保存',{exact:true}).click();
  const row=page.locator('.ext-row').filter({hasText:'e2e-scoped-game'});
  await row.getByRole('button',{name:'编辑',exact:true}).click();
  await page.locator('.ext-modal-head').getByRole('button',{name:'⇩ 从 JSON 填入',exact:true}).click();
  await page.locator('.ext-json textarea').fill(JSON.stringify({command:'echo',enabled:false}));
  await page.locator('.ext-json-ops').getByRole('button',{name:'填入',exact:true}).click();
  await fieldRow(page,'名称','.ext-modal').locator('input').fill('e2e-scoped-renamed');
  await page.locator('.ext-actions').getByText('保存',{exact:true}).click();
  const persisted=async()=>((await readState(request)).settings as {extensions:{name:string}[]}).extensions.find(ext=>ext.name==='e2e-scoped-renamed');
  await expect.poll(persisted).toMatchObject(policy);
  await page.reload();
  await openTab(page,'显示'); // An unrelated update sends the complete normalized state.
  const saved=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state'&&response.request().method()==='PUT'&&response.status()===204);
  await fieldRow(page,'显示对话状态').locator('.switch').click();
  await saved;
  await expect.poll(persisted).toMatchObject(policy);
});

test("显示设置：预览跟随对话状态开关", async ({
  page,
}) => {
  await openTab(page, "显示");
  await page.locator(".config-preview summary").click();
  const dialogPanel = page.locator("#config-display");
  await expect(page.getByText("语义检索", {exact:true})).toHaveCount(0);
  const preview = page.locator(".dialog-preview .chat-status");
  const sw = dialogPanel.locator(".opt-row", { hasText: "显示对话状态" }).locator(".switch");
  // 本开关的起点由前序用例决定，先归位到「开」再断言关掉后的效果
  if ((await sw.getAttribute("aria-checked")) !== "true") {
    await sw.click();
    await waitSaved(page);
  }
  await expect(preview).toHaveCount(1);
  await expect(preview).toContainText("空闲");
  await sw.click();
  await waitSaved(page);
  await expect(page.locator(".dialog-preview .chat-status")).toHaveCount(0);
});

test("设置操作按钮对齐，键盘关闭后焦点回到入口", async ({page}) => {
  await openTab(page, "模型");
  const actions = page.locator(".config-card .config-action");
  const boxes = await actions.evaluateAll(buttons => buttons.map(b => {
    const r = b.getBoundingClientRect();
    return {x:r.x, w:r.width, h:r.height};
  }));
  expect(boxes.length).toBeGreaterThanOrEqual(18);
  for (const box of boxes) expect(box).toEqual({x:boxes[0]!.x, w:112, h:34});
  const entry = page.getByRole("button", {name:"验证能力"});
  await entry.focus(); await entry.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(entry).toBeFocused();
});

test("探测按钮定宽：出结果不变宽，且与同列「显示」同宽", async ({ page }) => {
  await openTab(page, "模型");
  await page.getByRole("button", {name: "配置模型"}).click();
  const probe = page.locator(".probe-btn").first();
  // 同列的「显示」按钮：两者共用 .row-btn 的定宽，必须完全等宽
  const show = page.locator(".key-toggle.row-btn:not(.probe-btn)").first();

  const idle = await probe.boundingBox();
  const showBox = await show.boundingBox();
  expect(Math.abs((idle?.width ?? 0) - (showBox?.width ?? 0))).toBeLessThan(0.5);

  // 定宽的直接证据：把文案换成长度超过空闲态的结果，宽度必须纹丝不动。
  // （用 min-width + 自适应就会在这里变宽 → 同列输入框缩放、上下行按钮错位）
  const forced = await probe.evaluate((el) => {
    const prev = el.textContent;
    el.textContent = "✗ 999ms";
    const w = el.getBoundingClientRect().width;
    el.textContent = prev;
    return w;
  });
  expect(Math.abs(forced - (idle?.width ?? 0))).toBeLessThan(0.5);

  await probe.click();
  await expect(probe).toHaveClass(/probe-ok|probe-err/, { timeout: 25_000 });

  // 真跑一轮后：宽度仍与空闲态一致，且结果文字放得下（Range 实测）
  const m = await probe.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return {
      text: range.getBoundingClientRect().width,
      client: el.clientWidth,
      box: el.getBoundingClientRect().width,
    };
  });
  expect(Math.abs(m.box - (idle?.width ?? 0))).toBeLessThan(0.5);
  // 出结果后仍与「显示」等宽（这正是之前「改了测试忘了显示」的地方）
  expect(Math.abs(m.box - (showBox?.width ?? 0))).toBeLessThan(0.5);
  expect(m.text).toBeLessThanOrEqual(m.client + 0.5);
  expect(m.box).toBeGreaterThanOrEqual(60);
  expect(m.box).toBeLessThan(90);

  await expect(probe).toHaveText("测试", { timeout: 10_000 });
});

test("设置弹窗：Live2D 与「记忆」同构（检索 + 加号 + 翻页），加号开导入弹窗", async ({
  page,
}) => {
  await openExtensionTab(page, "Live2D");
  const panel = page.locator(".config-modal-body");

  await expect(panel.locator(".list-search")).toBeVisible();
  // 只取工具条的加号：卡片上还有编辑/删除两个 .icon-btn，多个匹配会触发严格模式报错
  await expect(panel.locator(".list-toolbar .icon-btn")).toBeVisible();
  await expect(panel.locator(".list-pager")).toBeVisible();
  await expect(panel.locator(".list-item").first()).toBeVisible();

  await panel.locator(".list-toolbar .icon-btn").click();
  await expect(page.locator(".modal-box:not(.config-modal)")).toBeVisible();
  await expect(page.locator(".modal-meta")).toHaveText("导入模型 (.zip)");
  await expect(page.locator(".avatar-drop")).toContainText("拖入");

  // 真拖一个文件进去：用非 zip 触发拒绝分支即可验证 onDrop 接上了，
  // 且不会写入任何持久状态（错误只留在弹窗内）。
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(["x"], "a.txt", { type: "text/plain" }));
    return d;
  });
  await page.locator(".avatar-drop").dispatchEvent("drop", { dataTransfer: dt });
  await expect(page.locator(".avatar-error")).toHaveText("不是有效的 zip 文件");

  await page.locator(".modal-foot").getByText("取消").click();
  await expect(page.locator(".modal-box:not(.config-modal)")).toBeHidden();
});

test("设置弹窗：点模型卡片弹出「表情与动作」，并可按名检索", async ({ page }) => {
  await openExtensionTab(page, "Live2D");
  const panel = page.locator(".config-modal-body");

  // 检索过滤（内置 Hiyori 命中，乱词落空态）
  await panel.locator(".list-search").fill("Hiyori");
  await expect(panel.locator(".list-item").first()).toBeVisible();
  await panel.locator(".list-search").fill("no-such-model-xyz");
  await expect(panel.locator(".muted", { hasText: "没有匹配的模型" })).toBeVisible();
  await panel.locator(".list-search").fill("");

  // 点卡片 → 弹窗里是该模型的清单，描述可编辑
  await panel.locator(".list-item").first().click();
  await expect(page.locator(".modal-meta")).toContainText("表情与动作");
  const row = page.locator(".avatar-res-row").first();
  await expect(row).toBeVisible();
  const desc = row.getByRole("textbox", {name: /· 实际表现$/});
  const before = await desc.inputValue();
  await desc.fill("e2e-描述");
  await expect(desc).toHaveValue("e2e-描述");
  await desc.fill(before); // 还原

  await page.locator(".modal-foot").getByText("关闭").click();
  await expect(page.locator(".modal-box:not(.config-modal)")).toBeHidden();
});

test("语言设置：下拉选项可见且可点", async ({ page }) => {
  await openTab(page, "语言");

  await fieldRow(page, "对话语言").locator(".sel-face").click();
  const list = page.locator(".sel-list");
  await expect(list).toBeVisible();

  // 层叠问题的可靠判据是命中测试：选项列底部那个点，谁在最上层。
  // 若被面板盖住，elementFromPoint 返回的是面板而不是选项列。
  const hit = await list.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.bottom - 6);
    return {
      inside: !!top && el.contains(top),
      who: top ? `${top.tagName}.${String(top.className)}`.slice(0, 60) : "(null)",
    };
  });
  expect(hit.inside, `命中到 ${hit.who} —— 选项列被别的面板盖住了`).toBe(true);

  // 选项可点（能选到非首项，说明整列都在最上层）
  await page.locator(".sel-opt").filter({ hasText: "日本語" }).click();
  await expect(page.locator(".config-index button").first()).toHaveText("语言"); // 界面语言未变
});

test("十章都不产生横向溢出", async ({ page }) => {
  await openApp(page, "settings");
  for (const tab of await page.locator(".config-index button").allTextContents()) {
    await page.locator(".config-index").getByRole("button", {name:tab, exact:true}).click();
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    // 「禁止溢出」是硬约束：任何 tab 出现横向滚动都算回归
    expect(scroll, `${tab} tab 出现横向溢出`).toBeLessThanOrEqual(client + 1);
  }
});

test('RoPE uses actual scroll distance and stays fixed under reduced motion', async ({page}) => {
  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.rotate;
    CanvasRenderingContext2D.prototype.rotate = function(angle) {
      if (this.canvas.matches('.config-document .grid-backdrop')) {
        this.canvas.dataset.drawnDegrees = String(angle * 180 / Math.PI);
      }
      original.call(this, angle);
    };
  });
  await openApp(page, 'settings');
  const angle = () => page.locator('.config-document canvas').evaluate(el => Number((el as HTMLElement).dataset.drawnDegrees));
  const scroll = page.locator('.config-scroll');
  for (const y of [500, 1000, 250, 0]) {
    await scroll.evaluate((el, target) => el.scrollTop = target, y);
    await expect.poll(angle).toBeCloseTo(25 + y * 0.02);
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await scroll.evaluate(el => el.scrollTop = 500);
  await expect.poll(angle).toBeCloseTo(25);
  await page.locator('[data-intro=tab-mods]').click();
  await expect(page.locator('[data-intro=tab-mods]')).toHaveAttribute('aria-current','location');
  expect(await angle()).toBeCloseTo(25);
});
