import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setBackendForTest, createMemoryStorage, getMemories } from "../lib/store";
import { extractAndApply } from "./extract";
import { addMemory } from "./store";

vi.mock("../llm/client", () => ({
  streamChat: vi.fn(),
}));

import { streamChat } from "../llm/client";

const mockStream = vi.mocked(streamChat);

let restore: () => void;

beforeEach(() => {
  restore = _setBackendForTest(createMemoryStorage());
  mockStream.mockReset();
});

afterEach(() => {
  restore();
});

const cfg = { url: "https://x.com", key: "", model: "m" };
const turn = { user: "我叫小明", assistant: "记住啦" };

describe("extractAndApply", () => {
  it("add op 创建记忆", async () => {
    mockStream.mockImplementation(async (_c, _m, opts) => {
      opts.onDelta('[{"op":"add","kind":"semantic","content":"用户叫小明"}]');
      return "";
    });
    const n = await extractAndApply(cfg, turn);
    expect(n).toBe(1);
    const mems = getMemories();
    expect(mems).toHaveLength(1);
    expect(mems[0].kind).toBe("semantic");
    expect(mems[0].content).toBe("用户叫小明");
  });

  it("kind 非法回退 semantic", async () => {
    mockStream.mockResolvedValue(
      '[{"op":"add","kind":"weird","content":"某条事实"}]',
    );
    await extractAndApply(cfg, turn);
    expect(getMemories()[0].kind).toBe("semantic");
  });

  it("invalidate 指向存在的 target_id", async () => {
    const old = addMemory("semantic", "用户住北京", "t")!;
    mockStream.mockResolvedValue(
      JSON.stringify([{ op: "invalidate", target_id: old.id }]),
    );
    const n = await extractAndApply(cfg, turn);
    expect(n).toBe(1);
    expect(getMemories()[0].valid).toBe(false);
  });

  it("invalidate 带 content：先 add 再指向新 id", async () => {
    const old = addMemory("semantic", "用户住北京", "t")!;
    mockStream.mockResolvedValue(
      JSON.stringify([
        { op: "invalidate", target_id: old.id, content: "用户搬到上海了" },
      ]),
    );
    const n = await extractAndApply(cfg, turn);
    expect(n).toBe(1);
    const mems = getMemories();
    expect(mems).toHaveLength(2);
    const stale = mems.find((m) => m.id === old.id)!;
    const fresh = mems.find((m) => m.id !== old.id)!;
    expect(stale.valid).toBe(false);
    expect(stale.supersededBy).toBe(fresh.id);
    expect(fresh.content).toBe("用户搬到上海了");
  });

  it("invalidate 不存在的 target_id 跳过", async () => {
    mockStream.mockResolvedValue(
      '[{"op":"invalidate","target_id":"mem_nothing"}]',
    );
    expect(await extractAndApply(cfg, turn)).toBe(0);
  });

  it("空数组 / 坏 JSON / 无括号 返回 0", async () => {
    mockStream.mockResolvedValue("[]");
    expect(await extractAndApply(cfg, turn)).toBe(0);
    mockStream.mockResolvedValue("[{oops");
    expect(await extractAndApply(cfg, turn)).toBe(0);
    mockStream.mockResolvedValue("没有括号");
    expect(await extractAndApply(cfg, turn)).toBe(0);
    expect(getMemories()).toHaveLength(0);
  });

  it("markdown 包裹也能截出数组", async () => {
    mockStream.mockResolvedValue(
      '好的\n```json\n[{"op":"add","content":"包了一层"}]\n```',
    );
    expect(await extractAndApply(cfg, turn)).toBe(1);
    expect(getMemories()[0].content).toBe("包了一层");
  });

  it("add 内容为空不计入应用数", async () => {
    mockStream.mockResolvedValue('[{"op":"add","kind":"semantic","content":""}]');
    expect(await extractAndApply(cfg, turn)).toBe(0);
  });

  it("LLM 调用失败向上抛", async () => {
    mockStream.mockRejectedValue(new Error("network down"));
    await expect(extractAndApply(cfg, turn)).rejects.toThrow("network down");
  });
});
