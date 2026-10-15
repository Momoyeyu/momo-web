import { describe, expect, it } from "vitest";
import type { DirectiveEvent } from "./directives";
import { DirectiveParser } from "./directives";

const text = (t: string): DirectiveEvent => ({ kind: "text", text: t });
const exp = (name: string): DirectiveEvent => ({ kind: "exp", name });
const motion = (id: string): DirectiveEvent => ({ kind: "motion", id });

describe("DirectiveParser 指令", () => {
  it("句首 <exp>", () => {
    const p = new DirectiveParser();
    expect(p.push("<exp>star_eyes</exp>今天好开心")).toEqual([
      exp("star_eyes"),
      text("今天好开心"),
    ]);
    expect(p.flush()).toEqual([]);
  });

  it("句中 <motion>", () => {
    const p = new DirectiveParser();
    expect(p.push("嗯，<motion>Idle/3</motion>有点害羞")).toEqual([
      text("嗯，"),
      motion("Idle/3"),
      text("有点害羞"),
    ]);
  });

  it("开标签跨 chunk 拆分", () => {
    const p = new DirectiveParser();
    expect(p.push("<mo")).toEqual([]);
    expect(p.push("tion>TapBody/0</motion>好")).toEqual([
      motion("TapBody/0"),
      text("好"),
    ]);
  });

  it("闭标签跨 chunk 拆分", () => {
    const p = new DirectiveParser();
    expect(p.push("<exp>fuki</exp><motion>Idle/")).toEqual([exp("fuki")]);
    expect(p.push("2</motion>对")).toEqual([motion("Idle/2"), text("对")]);
  });

  it("连续指令", () => {
    const p = new DirectiveParser();
    expect(
      p.push("<exp>a</exp><motion>Idle/0</motion> 唉"),
    ).toEqual([exp("a"), motion("Idle/0"), text(" 唉")]);
  });

  it("指令值不校验清单：未知资源照常产出事件（清单过滤在 turn 层）", () => {
    const p = new DirectiveParser();
    expect(p.push("<exp>no_such</exp>好")).toEqual([
      exp("no_such"),
      text("好"),
    ]);
  });
});

describe("DirectiveParser 容错", () => {
  it("非法开标签按文本：<expx>", () => {
    const p = new DirectiveParser();
    expect(p.push("a<expx>b")).toEqual([text("a<expx>b")]);
  });

  it("孤立 < 按文本", () => {
    const p = new DirectiveParser();
    expect(p.push("a < b")).toEqual([text("a < b")]);
    expect(p.flush()).toEqual([]);
  });

  it("连续 << 后一个仍可成开标签", () => {
    const p = new DirectiveParser();
    expect(p.push("<<exp>e</exp>x")).toEqual([
      text("<"),
      exp("e"),
      text("x"),
    ]);
  });

  it("流尾未闭合开标签退化为文本", () => {
    const p = new DirectiveParser();
    expect(p.push("前面<ex")).toEqual([text("前面")]);
    expect(p.flush()).toEqual([text("<ex")]);
    expect(p.flush()).toEqual([]);
  });

  it("流尾未闭合指令退化为文本", () => {
    const p = new DirectiveParser();
    expect(p.push("好<motion>Idle/")).toEqual([text("好")]);
    expect(p.flush()).toEqual([text("<motion>Idle/")]);
  });

  it("值内含失配闭标签：整段按值继续、flush 退化文本", () => {
    const p = new DirectiveParser();
    expect(p.push("<exp>a</motion>好")).toEqual([]);
    expect(p.flush()).toEqual([text("<exp>a</motion>好")]);
  });

  it("值超长退化为文本，不吞后续正文", () => {
    const p = new DirectiveParser();
    const long = `<exp>${"x".repeat(70)}</exp>后续`;
    const ev = p.push(long);
    // 超长处已按字面文本吐回；其后 "</exp>" 里的 "<" 重新走开标签判定，
    // "/exp>" 失配同样按文本——整体不失正文。
    expect(ev.join("")).toBeDefined();
    const texts = ev
      .filter((e) => e.kind === "text")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(texts.replaceAll("</exp>", "")).toContain("<exp>");
    expect(texts).toContain("后续");
  });
});

describe("DirectiveParser 实体解码", () => {
  it("&lt;/&gt; 解码为字面尖括号", () => {
    const p = new DirectiveParser();
    expect(p.push("1 &lt; 2 &gt; 0")).toEqual([text("1 < 2 > 0")]);
  });

  it("实体跨 chunk 拆分", () => {
    const p = new DirectiveParser();
    expect(p.push("a&l")).toEqual([text("a")]);
    expect(p.push("t; b")).toEqual([text("< b")]);
  });
});
