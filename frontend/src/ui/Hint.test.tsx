// Hint：圈内问号 + 悬停解释。结构单测（renderToStaticMarkup，不需要浏览器）。
//
// 关注点：说明必须同时挂在两处 ——
//   data-tip（CSS 浮窗，给鼠标用户）
//   aria-label（读屏用户拿不到 ::after 的内容）
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Hint from "./Hint";

describe("Hint", () => {
  const TEXT = "登记外部 MCP server 后，它的工具会从下一轮对话起可用";

  it("说明同时挂在 data-tip 与 aria-label 上", () => {
    const html = renderToStaticMarkup(createElement(Hint, { text: TEXT }));
    expect(html).toContain(`data-tip="${TEXT}"`);
    expect(html).toContain(`aria-label="${TEXT}"`);
  });

  it("默认朝上弹；贴顶的元素传 side=\"down\" 才用 .tip-b", () => {
    const up = renderToStaticMarkup(createElement(Hint, { text: TEXT }));
    expect(up).toContain('class="hint tip tip-l"');
    expect(up).not.toContain("tip-b");

    const down = renderToStaticMarkup(
      createElement(Hint, { text: TEXT, side: "down" }),
    );
    expect(down).toContain('class="hint tip tip-l tip-b"');
  });

  it("键盘可达：可聚焦，浮窗在 :focus-visible 时同样显示", () => {
    const html = renderToStaticMarkup(createElement(Hint, { text: TEXT }));
    expect(html).toContain('tabindex="0"');
  });

  it("用图标画圆与问号（不是 CSS 圆环 + 文字问号）", () => {
    // 图标自带圆环：问号天然居中、线宽与圆环统一，且随尺寸缩放
    const html = renderToStaticMarkup(createElement(Hint, { text: TEXT }));
    expect(html).toContain("<svg");
    expect(html).toContain("<circle");
    expect(html).toContain('stroke="currentColor"');
  });
});
