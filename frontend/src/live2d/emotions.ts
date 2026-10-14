// Hiyori 情绪 → 动作映射表（数据驱动，由 stage.playEmotion 消费）。
//
// 模型资源（public/live2d/hiyori/Hiyori.model3.json）没有 .exp3.json 表情
// 文件，动作只有两组：
//   "Idle"    index 0..8 ↔ m01, m02, m03, m05, m06, m07, m08, m09, m10
//   "TapBody" index 0    ↔ m04
// neutral 故意不映射——不主动播动作，交给 Live2D 的 Idle 自动轮播。

import type { EmotionTag } from "../lib/types";

/** 一条情绪 → 动作规则。 */
interface EmotionMotion {
  /** model3.json FileReferences.Motions 下的组名。 */
  group: "Idle" | "TapBody";
  /** 组内动作 index；省略时由库在组内随机挑选。 */
  index?: number;
}

/** 情绪 tag → Hiyori 动作。未列出的 tag（含未知值）由调用方静默忽略。 */
export const EMOTION_MOTIONS: Partial<Record<EmotionTag, EmotionMotion>> = {
  happy: { group: "TapBody", index: 0 }, // m04：被轻拍时的开心回应
  shy: { group: "Idle", index: 2 }, // m03
  thinking: { group: "Idle", index: 4 }, // m06
  surprised: { group: "Idle", index: 5 }, // m07
  sad: { group: "Idle", index: 6 }, // m08
  angry: { group: "Idle", index: 7 }, // m09
  sleepy: { group: "Idle", index: 8 }, // m10
};
