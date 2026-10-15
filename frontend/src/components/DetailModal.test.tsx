import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DetailModal from "./DetailModal";

const render = (props: Parameters<typeof DetailModal>[0]): string =>
  renderToStaticMarkup(createElement(DetailModal, props));

describe("DetailModal", () => {
  it("背景遮罩 + 居中弹窗 + 只读全文 + [关闭]", () => {
    const html = render({ text: "第一行\n第二行", onClose: () => {} });
    expect(html).toContain("detail-overlay");
    expect(html).toContain("detail-modal");
    expect(html).toContain("detail-body");
    expect(html).toContain("第一行");
    expect(html).toContain("第二行");
    expect(html).toContain("关闭"); // 默认中文
  });

  it("meta 可选：缺省不渲染 meta 行，传入则展示", () => {
    expect(render({ text: "x", onClose: () => {} })).not.toContain(
      "detail-meta",
    );
    const html = render({
      meta: "01/02 03:04",
      text: "x",
      onClose: () => {},
    });
    expect(html).toContain("detail-meta");
    expect(html).toContain("01/02 03:04");
  });
});
