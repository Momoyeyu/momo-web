import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DetailModal from "./DetailModal";

// node 测试环境无 DOM：createPortal 打平为原样返回 + stub document。
vi.mock("react-dom", () => ({
  createPortal: (children: unknown) => children,
}));
vi.stubGlobal("document", { body: null });

const render = (props: Parameters<typeof DetailModal>[0]): string =>
  renderToStaticMarkup(createElement(DetailModal, props));

describe("DetailModal", () => {
  it("聚焦遮罩 + 居中弹窗 + 只读全文 + [关闭]", () => {
    const html = render({ text: "第一行\n第二行", onClose: () => {} });
    expect(html).toContain("modal-overlay");
    expect(html).toContain("modal-box");
    expect(html).toContain("modal-body");
    expect(html).toContain("第一行");
    expect(html).toContain("第二行");
    expect(html).toContain("关闭"); // 默认中文
  });

  it("meta 可选：缺省不渲染 meta 行，传入则展示", () => {
    expect(render({ text: "x", onClose: () => {} })).not.toContain(
      "modal-meta",
    );
    const html = render({
      meta: "01/02 03:04",
      text: "x",
      onClose: () => {},
    });
    // 绑定「meta 文本确实在这个 meta 元素里」——只断言 contain("modal-meta")
    // 的话，把整行删掉反而永远通过
    expect(html).toMatch(/modal-meta[^>]*>[^<]*01\/02 03:04/);
  });
});
