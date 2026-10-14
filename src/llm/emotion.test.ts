import { describe, expect, it } from "vitest";
import type { EmotionEvent } from "./emotion";
import { EmotionParser } from "./emotion";

const text = (t: string): EmotionEvent => ({ kind: "text", text: t });
const emo = (tag: string): EmotionEvent =>
  ({ kind: "emotion", tag }) as EmotionEvent;

describe("EmotionParser #指令", () => {
  it("句首 #tag", () => {
    const p = new EmotionParser();
    expect(p.push("#happy 今天好开心")).toEqual([
      emo("happy"),
      text(" 今天好开心"),
    ]);
    expect(p.flush()).toEqual([]);
  });

  it("句中 #tag", () => {
    const p = new EmotionParser();
    expect(p.push("嗯，#sad 有点难过")).toEqual([
      text("嗯，"),
      emo("sad"),
      text(" 有点难过"),
    ]);
  });

  it("跨 chunk 拆分的 #tag", () => {
    const p = new EmotionParser();
    expect(p.push("#ha")).toEqual([]);
    expect(p.push("ppy 好的")).toEqual([emo("happy"), text(" 好的")]);
  });

  it("流尾恰好停在 #tag 末尾（flush 结算）", () => {
    const p = new EmotionParser();
    expect(p.push("好的#thinking")).toEqual([text("好的")]);
    expect(p.flush()).toEqual([emo("thinking")]);
  });

  it("未知 #tag 静默丢弃，不进文本", () => {
    const p = new EmotionParser();
    expect(p.push("#playful 你好")).toEqual([text(" 你好")]);
    expect(p.flush()).toEqual([]);
  });

  it("# 后非字母退化：# 按文本", () => {
    const p = new EmotionParser();
    expect(p.push("排#1 名")).toEqual([text("排#1 名")]);
  });

  it("连续指令", () => {
    const p = new EmotionParser();
    expect(p.push("#happy#sad 唉")).toEqual([
      emo("happy"),
      emo("sad"),
      text(" 唉"),
    ]);
  });
});

describe("EmotionParser [tag] 兼容", () => {
  it("句首 [tag]", () => {
    const p = new EmotionParser();
    expect(p.push("[happy]今天好开心")).toEqual([
      emo("happy"),
      text("今天好开心"),
    ]);
    expect(p.flush()).toEqual([]);
  });

  it("跨 chunk 拆分的 [tag]", () => {
    const p = new EmotionParser();
    expect(p.push("[ha")).toEqual([]);
    expect(p.push("ppy]好的")).toEqual([emo("happy"), text("好的")]);
  });

  it("未知 [tag] 静默丢弃（不再漏进文本）", () => {
    const p = new EmotionParser();
    expect(p.push("[playful]你好呀")).toEqual([text("你好呀")]);
  });

  it("含非 tag 字符的方括号按文本（如 [注）", () => {
    const p = new EmotionParser();
    expect(p.push("[注 释]内容")).toEqual([text("[注 释]内容")]);
  });

  it("嵌套 [ 前一个作废、后一个可成 tag", () => {
    const p = new EmotionParser();
    expect(p.push("[a[happy]好")).toEqual([text("[a"), emo("happy"), text("好")]);
  });

  it("flush 把未闭合 [ 残片按文本吐净", () => {
    const p = new EmotionParser();
    expect(p.push("前面[thin")).toEqual([text("前面")]);
    expect(p.flush()).toEqual([text("[thin")]);
    expect(p.flush()).toEqual([]);
  });
});
