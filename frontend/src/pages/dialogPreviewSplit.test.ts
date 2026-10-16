import { describe, expect, it } from "vitest";
import { SentenceSplitter } from "./dialogPreviewSplit";

describe("SentenceSplitter", () => {
  it("强边界立刻成句", () => {
    const s = new SentenceSplitter();
    expect(s.push("你好。")).toEqual(["你好。"]);
    expect(s.flush()).toBeNull();
  });

  it("一句多个强边界切多句", () => {
    const s = new SentenceSplitter();
    expect(s.push("啊！真的吗？太好了。")).toEqual([
      "啊！",
      "真的吗？",
      "太好了。",
    ]);
  });

  it("换行是强边界", () => {
    const s = new SentenceSplitter();
    expect(s.push("第一行\n第二行")).toEqual(["第一行"]);
    expect(s.flush()).toBe("第二行");
  });

  it("全角省略号 …… 并入同一句", () => {
    const s = new SentenceSplitter();
    expect(s.push("他走了……")).toEqual(["他走了……"]);
    expect(s.push("好吧")).toEqual([]);
    expect(s.flush()).toBe("好吧");
  });

  it("跨 chunk 的残句", () => {
    const s = new SentenceSplitter();
    expect(s.push("今天天气")).toEqual([]);
    expect(s.push("不错呢！你说")).toEqual(["今天天气不错呢！"]);
    expect(s.flush()).toBe("你说");
  });

  it("弱边界在缓冲达到 weakMinLen 才成句", () => {
    const s = new SentenceSplitter();
    const long = "话".repeat(45);
    expect(s.push(`${long}，还没完`)).toEqual([`${long}，`]);
    expect(s.flush()).toBe("还没完");
  });

  it("弱边界未到阈值不成句", () => {
    const s = new SentenceSplitter();
    expect(s.push("短，句")).toEqual([]);
    expect(s.flush()).toBe("短，句");
  });

  it("自定义 weakMinLen", () => {
    const s = new SentenceSplitter({ weakMinLen: 3 });
    expect(s.push("你好，呀")).toEqual(["你好，"]);
    expect(s.flush()).toBe("呀");
  });

  it("trim 首尾空白、空句丢弃", () => {
    const s = new SentenceSplitter();
    expect(s.push("  你好。  ")).toEqual(["你好。"]);
    expect(s.flush()).toBeNull();
    const s2 = new SentenceSplitter();
    expect(s2.push("\n\n")).toEqual([]);
    expect(s2.flush()).toBeNull();
  });

  it("？！连写并入一句", () => {
    const s = new SentenceSplitter();
    expect(s.push("什么？！真的假的")).toEqual(["什么？！"]);
    expect(s.flush()).toBe("真的假的");
  });
});
