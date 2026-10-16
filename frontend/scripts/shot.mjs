// 改样式时的自查工具：截一张图，并可打印关键元素的几何用于逐项对照。
//
//   pnpm shot settings 拓展 /tmp/ext.png   # 路由 + tab + 输出路径
//   MEASURE=1 pnpm shot settings 拓展      # 额外打印左右栏对应元素的 x/y/宽/高
//
// 为什么需要它：肉眼看截图容易误判（曾误以为两侧卡片不等高，实测两边都是 70px），
// 所以「看起来不和谐」的点要先用几何数据确认，再决定改不改。
import { chromium } from "@playwright/test";

const [route = "chat", tab, out = `/tmp/momo-${route}.png`] = process.argv.slice(2);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
await page.goto(`http://localhost:5173/#/${route}`, { waitUntil: "networkidle" });
if (tab) await page.locator(".stab", { hasText: tab }).click();
await page.waitForTimeout(900);
await page.screenshot({ path: out });
console.log(`截图：${out}`);

if (process.env.MEASURE === "1") {
  // 双栏页面的对照项：同名元素在左右面板里的几何必须一致
  for (const sel of ["", " .opt-group", " .list-search", " .list-item", " .list-foot"]) {
    for (const pane of [".panel-stack", ".ext-panel"]) {
      const el = page.locator(pane + sel).first();
      if (!(await el.count())) continue;
      const b = await el.boundingBox();
      console.log(
        `  ${(pane + sel).padEnd(32)} x=${Math.round(b.x)} y=${Math.round(b.y)} w=${Math.round(b.width)} h=${Math.round(b.height)}`,
      );
    }
  }
}
await browser.close();
