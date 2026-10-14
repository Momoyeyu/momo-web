// 流式句切：把 LLM 增量文本切成可送 TTS 的句子。
// 强边界：。！？!?…\n 立刻成句；弱边界：，、；;：: 在缓冲超过阈值时成句；
// flush() 吐出收尾残余。纯函数可测。

const STRONG = new Set(["。", "！", "？", "!", "?", "…", "\n"]);
const WEAK = new Set(["，", "、", "；", ";", "：", ":"]);

/** 是否整段都是强边界标点（如 "……"、"？！" 这类连写尾巴）。 */
function allStrong(s: string): boolean {
  if (!s.length) return false;
  for (const ch of s) if (!STRONG.has(ch)) return false;
  return true;
}

export class SentenceSplitter {
  private buf = "";
  private readonly weakMinLen: number;

  constructor(opts?: { weakMinLen?: number }) {
    this.weakMinLen = opts?.weakMinLen ?? 40;
  }

  /** 喂入增量，返回 0..n 个完整句子（不含标点外空白）。 */
  push(text: string): string[] {
    const out: string[] = [];
    const seal = (): void => {
      const s = this.buf.trim();
      this.buf = "";
      if (!s) return;
      // 连写强标点（"……"、"？！"）并入上一句，不单独成句
      if (allStrong(s) && out.length > 0) {
        out[out.length - 1] += s;
      } else {
        out.push(s);
      }
    };
    for (const ch of text) {
      this.buf += ch;
      if (STRONG.has(ch)) {
        seal();
      } else if (WEAK.has(ch) && this.buf.length >= this.weakMinLen) {
        seal();
      }
    }
    return out;
  }

  /** 收尾残余；无残余返回 null。 */
  flush(): string | null {
    const s = this.buf.trim();
    this.buf = "";
    return s ? s : null;
  }
}
