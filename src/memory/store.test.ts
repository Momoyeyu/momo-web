import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setBackendForTest,
  createMemoryStorage,
  getMemories,
} from "../lib/store";
import {
  addMemory,
  deleteMemory,
  editMemory,
  invalidateMemory,
  listMemories,
  recallBlock,
  searchMemories,
} from "./store";

let restore: () => void;

beforeEach(() => {
  restore = _setBackendForTest(createMemoryStorage());
});

afterEach(() => {
  restore();
});

describe("addMemory", () => {
  it("创建并落库", () => {
    const m = addMemory("semantic", "用户叫小明", "t1");
    expect(m).not.toBeNull();
    expect(m!.id).toMatch(/^mem_/);
    expect(m!.valid).toBe(true);
    expect(m!.source).toBe("t1");
    expect(getMemories()).toHaveLength(1);
  });

  it("空内容返回 null", () => {
    expect(addMemory("semantic", "   ", "t")).toBeNull();
  });

  it("归一化全等去重", () => {
    addMemory("semantic", "用户不喜欢吃辣", "t");
    expect(addMemory("semantic", " 用户不喜欢吃辣。", "t")).toBeNull();
    expect(getMemories()).toHaveLength(1);
  });

  it("bigram Jaccard>0.85 去重", () => {
    addMemory("semantic", "他每天都喝咖啡", "t");
    expect(addMemory("semantic", "他每天都喝咖啡了", "t")).toBeNull();
    expect(getMemories()).toHaveLength(1);
  });

  it("差异足够大不去重", () => {
    addMemory("semantic", "他每天都喝咖啡", "t");
    expect(addMemory("semantic", "她周末喜欢爬山", "t")).not.toBeNull();
  });
});

describe("invalidate/edit/delete", () => {
  it("invalidate 置 valid=false + supersededBy", () => {
    const m = addMemory("semantic", "旧记忆", "t")!;
    invalidateMemory(m.id, "void:x");
    const cur = getMemories()[0];
    expect(cur.valid).toBe(false);
    expect(cur.supersededBy).toBe("void:x");
  });

  it("editMemory 新增一条并链上 supersededBy", () => {
    const old = addMemory("semantic", "喜欢猫", "t")!;
    const created = editMemory(old.id, "喜欢狗");
    expect(created).not.toBeNull();
    expect(created!.kind).toBe("semantic");
    expect(created!.source).toBe("manual");
    const list = getMemories();
    const stale = list.find((m) => m.id === old.id)!;
    expect(stale.valid).toBe(false);
    expect(stale.supersededBy).toBe(created!.id);
  });

  it("editMemory 内容重复时返回 null、旧条仍 valid", () => {
    const old = addMemory("semantic", "喜欢猫", "t")!;
    expect(editMemory(old.id, "喜欢猫")).toBeNull();
    expect(getMemories().find((m) => m.id === old.id)!.valid).toBe(true);
  });

  it("deleteMemory 软删 supersededBy=void:delete", () => {
    const m = addMemory("episodic", "昨天聊到了海边的旅行", "t")!;
    deleteMemory(m.id);
    const cur = getMemories()[0];
    expect(cur.valid).toBe(false);
    expect(cur.supersededBy).toBe("void:delete");
  });
});

describe("listMemories / searchMemories", () => {
  it("默认只回 valid，includeInvalid 全回", () => {
    const a = addMemory("semantic", "甲", "t")!;
    addMemory("semantic", "乙", "t");
    deleteMemory(a.id);
    expect(listMemories()).toHaveLength(1);
    expect(listMemories(true)).toHaveLength(2);
  });

  it("searchMemories 子串命中", () => {
    addMemory("semantic", "用户特别喜欢甜食", "t");
    addMemory("semantic", "明天要早起开会", "t");
    const hits = searchMemories("甜食");
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("甜食");
  });

  it("searchMemories bigram 重叠命中（非子串）", () => {
    addMemory("semantic", "他每天都喝咖啡", "t");
    addMemory("semantic", "完全无关的事", "t");
    const hits = searchMemories("喝咖啡习惯");
    expect(hits.map((m) => m.content)).toEqual(["他每天都喝咖啡"]);
  });

  it("searchMemories 不命中失效条目", () => {
    const m = addMemory("semantic", "关于甜食的记忆", "t")!;
    deleteMemory(m.id);
    expect(searchMemories("甜食")).toHaveLength(0);
  });
});

describe("recallBlock", () => {
  it("全空返回空串", () => {
    expect(recallBlock("随便说点啥")).toBe("");
  });

  it("各 kind 行注入（用户身份已由 prompt 固定段承担，不进召回）", () => {
    addMemory("semantic", "用户叫阿明", "t");
    addMemory("procedural", "回复别太长", "t");
    const block = recallBlock("今天怎么样");
    const lines = block.split("\n");
    expect(lines).toContain("- 用户叫阿明");
    expect(lines).toContain("- 回复别太长");
  });

  it("episodic 只在与 userText 有重叠时注入", () => {
    addMemory("episodic", "上周用户去了海边玩，晒伤了", "t");
    const hit = recallBlock("海边好玩吗");
    expect(hit).toContain("- 上周用户去了海边玩，晒伤了");
    const miss = recallBlock("完全不同的xyz话题");
    expect(miss).toBe("");
  });

  it("失效条目不召回", () => {
    const m = addMemory("semantic", "用户叫阿明", "t")!;
    deleteMemory(m.id);
    expect(recallBlock("你好")).toBe("");
  });

  it("总长不超过 2000，超出丢末条", () => {
    addMemory("semantic", "短".repeat(1500), "t");
    addMemory("episodic", "尾".repeat(900) + "海边", "t");
    const block = recallBlock("海边");
    expect(block.length).toBeLessThanOrEqual(2000);
    expect(block).not.toContain("尾".repeat(10));
  });
});
