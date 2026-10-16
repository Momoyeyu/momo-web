// **仅供设置页「对话框预览」演示切句**：把那段固定样例切成句子，
// 好让预览演示句间停顿。
//
// 真实对话的切句**不在这里** —— 后端 app/core/sentences.py 是唯一口径
// （见 docs/sentences-plan.md），前端只消费后端下发的 sentence 事件。
// 两边规则不同是刻意的：这里只求演示观感，不需要与后端逐字一致。

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

  /** 生产中的未断句尾部（展示层逐字上屏用；含未 trim 的原文）。 */
  get pending(): string {
    return this.buf;
  }

  /** 收尾残余；无残余返回 null。 */
  flush(): string | null {
    const s = this.buf.trim();
    this.buf = "";
    return s ? s : null;
  }
}
