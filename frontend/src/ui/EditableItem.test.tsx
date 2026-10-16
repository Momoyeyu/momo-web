// 列表卡片结构：正文左（.list-main，垂直居中的前提）、图标操作列右（.list-ops）。
// 锁住这次「编辑/删除 文字按钮 → 右侧图标」的改动，避免以后被静默改回。

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EditableItem from "./EditableItem";

const render = (over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    createElement(EditableItem, {
      editing: false,
      edit: createElement("div", { className: "list-edit" }, "编辑表单"),
      onStartEdit: () => {},
      onDelete: () => {},
      children: "正文",
      ...over,
    }),
  );

describe("EditableItem：正文左 / 图标操作列右", () => {
  it("常态：正文与头部行装在 .list-main，操作列在右侧且是带 aria-label 的图标按钮", () => {
    const html = render({
      head: createElement("span", { className: "muted" }, "10/15 22:53"),
      actions: createElement("button", { className: "mem-pinicon" }, "pin"),
    });

    expect(html).toContain('class="list-item list-open"');
    // 头部行与正文都在 .list-main 里 —— 这正是「正文能垂直居中」的前提
    expect(html).toMatch(/class="list-main"[\s\S]*10\/15 22:53[\s\S]*正文/);
    // 操作列排在正文之后
    expect(html.indexOf("list-ops")).toBeGreaterThan(html.indexOf("list-main"));
    // 编辑/删除已是纯图标按钮（靠 aria-label + data-tip 而非可见文字）
    expect(html).toMatch(
      /<button[^>]*class="icon-btn tip tip-r"[^>]*aria-label="编辑"/,
    );
    expect(html).toMatch(
      /<button[^>]*class="icon-btn danger tip tip-r"[^>]*aria-label="删除"/,
    );
    // actions（图钉）排在编辑之前，同一列
    expect(html.indexOf("mem-pinicon")).toBeLessThan(html.indexOf("aria-label=\"编辑\""));
    // 不再有文字按钮
    expect(html).not.toMatch(/>\s*编辑\s*</);
  });

  it("编辑态：整卡换成 edit 表单（.list-editing），不渲染操作列", () => {
    const html = render({ editing: true });
    expect(html).toContain('class="list-item list-editing"');
    expect(html).toContain("list-edit");
    expect(html).not.toContain("list-ops");
  });

  it("没有 onDelete 时不渲染删除按钮", () => {
    const html = render({ onDelete: undefined });
    expect(html).toContain('aria-label="编辑"');
    expect(html).not.toContain('aria-label="删除"');
  });
});
