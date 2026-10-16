import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Button from "./Button";

type Props = Parameters<typeof Button>[0];

const cls = (props: Props): string | undefined => {
  const html = renderToStaticMarkup(
    createElement(Button, { ...props, children: "x" }),
  );
  return /class="([^"]*)"/.exec(html)?.[1];
};

describe("Button 的类串映射（必须与封装前的 className 逐字一致）", () => {
  it("标准组合", () => {
    // 封装前的实心按钮：完全没有 className 属性
    expect(cls({})).toBeUndefined();
    expect(cls({ variant: "ghost" })).toBe("ghost");
    expect(cls({ size: "sm" })).toBe("small");
    expect(cls({ variant: "ghost", size: "sm" })).toBe("ghost small");
  });

  it("className 逃生口：页面私有类原样拼在末尾", () => {
    expect(cls({ variant: "ghost", className: "key-toggle" })).toBe(
      "ghost key-toggle",
    );
    expect(cls({ variant: "ghost", className: "key-toggle", size: "sm" })).toBe(
      "ghost small key-toggle",
    );
    // 整块私有形态（无 ghost/small）：类串就是 className 本身
    expect(cls({ className: "tb" })).toBe("tb");
    expect(cls({ className: "menu-item" })).toBe("menu-item");
    expect(cls({ variant: "ghost", size: "sm", className: "slot-del" })).toBe(
      "ghost small slot-del",
    );
  });

  it("type 默认为 button，可覆盖；其余原生属性透传", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { disabled: true, title: "t", children: "x" }),
    );
    expect(html).toContain('type="button"');
    expect(html).toContain("disabled");
    expect(html).toContain('title="t"');
    expect(
      renderToStaticMarkup(
        createElement(Button, { type: "submit", children: "x" }),
      ),
    ).toContain('type="submit"');
  });
});
