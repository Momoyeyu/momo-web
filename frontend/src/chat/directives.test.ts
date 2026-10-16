import { describe, expect, it } from "vitest";
import { dirAllowed, dueDirs } from "./directives";
import type { PendingDir } from "./directives";
import type { AvatarResources } from "../lib/types";

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

  it("offset 越界收敛到句尾（floor(reveal) >= len-1）", () => {
    const dirs = [exp(20)];
    expect(dueDirs(dirs, 0, 8, 10)).toBe(0);
    expect(dueDirs(dirs, 0, 9, 10)).toBe(1);
    expect(dueDirs(dirs, 0, 10, 10)).toBe(1);
    expect(dueDirs([exp(-1)], 0, 0, 10)).toBe(1); // 负 offset 钳到句首
  });

  it("多条按序触发，前面的未到位则后面不越序", () => {
    expect(dueDirs([exp(2), exp(5), exp(8)], 0, 5, 10)).toBe(2);
    // 前序已触发 2 条后，剩余按 reveal 判
    expect(dueDirs([exp(2), exp(5), exp(8)], 2, 5, 10)).toBe(2);
    expect(dueDirs([exp(2), exp(5), exp(8)], 2, 9, 10)).toBe(3);
    // 同一条单调规则的两个端点：句首 offset=0、同 offset 多条
    expect(dueDirs([exp(0)], 0, 0, 10)).toBe(1);
    expect(dueDirs([exp(4), exp(4)], 0, 4, 10)).toBe(2);
  });

});

describe("dirAllowed 解析层清单校验", () => {
  const res: AvatarResources = {
    expressions: [
      { name: "star_eyes", desc: "星星眼" },
      { name: "fukidashi", desc: "惊讶冒泡" },
    ],
    motions: [
      { name: "Idle/3", desc: "害羞地低头" },
      { name: "TapBody/0", desc: "蹦一下" },
    ],
  };

  it("清单内通过、清单外丢弃（通道各自查表）", () => {
    expect(dirAllowed("exp", "star_eyes", res)).toBe(true);
    expect(dirAllowed("exp", "sad", res)).toBe(false);
    expect(dirAllowed("motion", "Idle/3", res)).toBe(true);
    expect(dirAllowed("motion", "Nope/9", res)).toBe(false);
    // 同名不同通道不互认
    expect(dirAllowed("motion", "star_eyes", res)).toBe(false);
  });

  it("清单缺失（形象未解析出 resources）不拦，交 stage 兜底", () => {
    expect(dirAllowed("exp", "whatever", undefined)).toBe(true);
  });
});
