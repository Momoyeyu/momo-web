// 流式情绪/动作指令解析器。
// 指令与正文是两条独立通道：模型输出 `#tag`（井号+tag）表示情绪/动作切换，
// 兼容遗留的 `[tag]` 内联形式。指令只产出 emotion 事件，绝不进入可见文本。
// 白名单外的 `#xxx` / `[xxx]` 一律丢弃（未知指令容错），不会漏进字幕或 TTS。
// 纯函数可测。

import type { EmotionTag } from "../lib/types";
import { EMOTION_TAGS, isEmotionTag } from "../lib/types";

export type EmotionEvent =
  | { kind: "text"; text: string }
  | { kind: "emotion"; tag: EmotionTag };

/** 合法 tag 只含小写字母；长度不可能超过白名单里最长的 tag。 */
const MAX_TAG_LEN = Math.max(...EMOTION_TAGS.map((t) => t.length));
const TAG_CHAR = /[a-z]/;

type Pending = { kind: "#" | "["; buf: string } | null;

export class EmotionParser {
  /** 待合并的纯文本。 */
  private text = "";
  /** 未决指令缓冲（不含起始符）。 */
  private pending: Pending = null;

  /** 喂入一段流式增量，返回本次解析出的事件。 */
  push(delta: string): EmotionEvent[] {
    const out: EmotionEvent[] = [];
    const emitText = (): void => {
      if (this.text) {
        // 与上一条 text 事件合并，避免伪指令（#1、未闭合 [）切碎文本流。
        const last = out[out.length - 1];
        if (last && last.kind === "text") {
          last.text += this.text;
        } else {
          out.push({ kind: "text", text: this.text });
        }
        this.text = "";
      }
    };
    const resolve = (tag: string): void => {
      // 白名单 → 情绪事件；未知 → 静默丢弃。
      if (isEmotionTag(tag)) {
        emitText();
        out.push({ kind: "emotion", tag });
      }
      this.pending = null;
    };
    /** '#' 后以字母终止：结算指令，terminator 字符重新走普通流程。 */
    const resolveHash = (): void => {
      resolve(this.pending?.buf ?? "");
    };

    for (const ch of delta) {
      if (this.pending === null) {
        if (ch === "#" || ch === "[") {
          emitText();
          this.pending = { kind: ch, buf: "" };
        } else {
          this.text += ch;
        }
        continue;
      }

      if (this.pending.kind === "#") {
        if (TAG_CHAR.test(ch) && this.pending.buf.length < MAX_TAG_LEN) {
          this.pending.buf += ch;
        } else {
          const wasEmpty = this.pending.buf.length === 0;
          resolveHash();
          if (wasEmpty) {
            // '#' 后不是字母（如 "#1"、空格）：'#' 本身退化为文本。
            this.text += "#";
          }
          // 终止符重新参与判定（可能是新指令的起始符）。
          if (ch === "#" || ch === "[") {
            emitText();
            this.pending = { kind: ch, buf: "" };
          } else {
            this.text += ch;
          }
        }
        continue;
      }

      // pending.kind === "["
      if (ch === "]") {
        resolve(this.pending.buf);
      } else if (ch === "[") {
        // 嵌套 "["：前一个候选未含 ']'，退回文本，重新判定。
        this.text += `[${this.pending.buf}`;
        this.pending.buf = "";
      } else if (ch === "#") {
        // 未闭合 "[" 遇到 '#'：候选作废为文本，'#' 起新指令。
        this.text += `[${this.pending.buf}`;
        this.pending = { kind: "#", buf: "" };
      } else if (TAG_CHAR.test(ch) && this.pending.buf.length < MAX_TAG_LEN) {
        this.pending.buf += ch;
      } else {
        // 含非 tag 字符（空格/大写/数字/CJK）：这不是指令，整段按文本。
        this.text += `[${this.pending.buf}${ch}`;
        this.pending = null;
      }
    }
    emitText();
    return out;
  }

  /** 流结束：冲刷内部缓冲（'#' 按指令结算；未闭合 '[' 退化为文本）。 */
  flush(): EmotionEvent[] {
    const out: EmotionEvent[] = [];
    if (this.pending) {
      if (this.pending.kind === "#") {
        if (isEmotionTag(this.pending.buf)) {
          out.push({ kind: "emotion", tag: this.pending.buf });
        } else if (this.pending.buf.length === 0) {
          this.text += "#";
        }
        // 未知 #xxx 丢弃
      } else {
        this.text += `[${this.pending.buf}`;
      }
      this.pending = null;
    }
    if (this.text) {
      out.push({ kind: "text", text: this.text });
      this.text = "";
    }
    return out;
  }
}
