// 表情/动作指令的「展示时」触发判定。
// 指令解析时只记录其在「未断句尾部」的字符偏移（turn.ts feedEvents），
// 真正派发等字幕逐字上屏越过该位置——与文字同步而非与生成同步。
// 纯函数可测。

import type { AvatarResources } from "../lib/types";

/** 一条待触发指令：通道 + 资源名 + 所在句内的字符偏移。 */
export interface PendingDir {
  kind: "exp" | "motion";
  name: string;
  /** 所在句的字符偏移；>= 句长时收敛到句尾。 */
  offset: number;
}

/**
 * 解析层清单校验：指令值是否在当前形象的资源清单中（action.md——
 * 清单外静默丢弃）。在 turn 层指令调度前过滤，不等 stage：
 * 形象清单来自 store（含内置出厂清单），不依赖模型加载进度。
 * res 缺失（导入形象尚未解析出清单）时不拦，交给 stage 层兜底校验。
 */
export function dirAllowed(
  kind: PendingDir["kind"],
  name: string,
  res: AvatarResources | undefined,
): boolean {
  if (!res) return true;
  const list = kind === "exp" ? res.expressions : res.motions;
  return list.some((r) => r.name === name);
}

/**
 * 从已触发游标 dirIdx 起，reveal（逐字上屏进度，浮点）已越过其位置的
 * 连续指令数量——即本 tick 应按序派发的条数。
 * 判定：floor(reveal) >= min(offset, len-1)；offset 越界按句尾处理。
 */
export function dueDirs(
  dirs: PendingDir[],
  dirIdx: number,
  reveal: number,
  len: number,
): number {
  const shown = Math.floor(reveal);
  let n = dirIdx;
  while (n < dirs.length && shown >= Math.min(dirs[n].offset, len - 1)) {
    n += 1;
  }
  return n;
}
