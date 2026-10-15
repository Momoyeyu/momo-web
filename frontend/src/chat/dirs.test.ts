import { describe, expect, it } from "vitest";
import { dueDirs } from "./dirs";
import type { PendingDir } from "./dirs";

const exp = (offset: number): PendingDir => ({
  kind: "exp",
  name: "happy",
  offset,
});

describe("dueDirs", () => {
  it("reveal 未越过 offset 不触发", () => {
    const dirs = [exp(3)];
    expect(dueDirs(dirs, 0, 0, 10)).toBe(0);
    expect(dueDirs(dirs, 0, 2.9, 10)).toBe(0);
    expect(dueDirs(dirs, 0, 3, 10)).toBe(1);
  });

  it("offset=0 句首即触发", () => {
    expect(dueDirs([exp(0)], 0, 0, 10)).toBe(1);
  });

  it("offset 越界收敛到句尾（floor(reveal) >= len-1）", () => {
    const dirs = [exp(20)];
    expect(dueDirs(dirs, 0, 8, 10)).toBe(0);
    expect(dueDirs(dirs, 0, 9, 10)).toBe(1);
    expect(dueDirs(dirs, 0, 10, 10)).toBe(1);
  });

  it("多条按序触发，前面的未到位则后面不越序", () => {
    const dirs = [exp(2), exp(5), exp(8)];
    expect(dueDirs(dirs, 0, 5, 10)).toBe(2);
    // 前序已触发 2 条后，剩余按 reveal 判
    expect(dueDirs(dirs, 2, 5, 10)).toBe(2);
    expect(dueDirs(dirs, 2, 9, 10)).toBe(3);
  });

  it("同 offset 多条一次全触发", () => {
    const dirs = [exp(4), exp(4)];
    expect(dueDirs(dirs, 0, 4, 10)).toBe(2);
  });
});
