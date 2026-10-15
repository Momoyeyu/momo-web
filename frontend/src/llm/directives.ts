// 流式表情/动作指令解析器。
// LLM 在正文中内联输出 XML 指令：<exp>名称</exp> 切换表情（持续到回合结束）、
// <motion>组名/序号</motion> 播放一次动作。指令剥除后不进入字幕与 TTS 文本，
// 解析到即产出事件（与字幕近似同步）。资源清单校验在 stage 层——
// 清单外的指令值照常产出事件，由消费方静默丢弃。
// 容错：畸形/未闭合标记退化为字面文本，不会吃掉正文；正文里的
// &lt; / &gt; / &amp; 实体解码回字面字符。

export type DirectiveEvent =
  | { kind: "text"; text: string }
  | { kind: "exp"; name: string }
  | { kind: "motion"; id: string };

type Channel = "exp" | "motion";

/** 开标签字面量 → 通道。 */
const OPEN_TAGS: [string, Channel][] = [
  ["<exp>", "exp"],
  ["<motion>", "motion"],
];
/** 指令值上限：超出即按畸形处理（退化为文本），防止未闭合标记吃掉整段回复。 */
const MAX_VALUE_LEN = 64;
/** 文本通道解码的实体集（解析器只吃字面 <exp>/<motion>，尖括号靠实体绕过）。 */
const ENTITIES: [string, string][] = [
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&amp;", "&"],
];

function decodeEntities(s: string): string {
  let out = s;
  for (const [k, v] of ENTITIES) out = out.split(k).join(v);
  return out;
}

/** 尾部若是某实体的未完成前缀（"&"、"&lt"），返回其起点下标（留到下一块再解码）。 */
function entityTail(s: string): number {
  for (let i = Math.max(0, s.length - 5); i < s.length; i++) {
    const suf = s.slice(i);
    if (ENTITIES.some(([k]) => k.startsWith(suf) && k !== suf)) return i;
  }
  return -1;
}

export class DirectiveParser {
  private text = "";
  /** 开标签未决片段（"<"、"<ex" 等，含 "<"）。 */
  private open: string | null = null;
  /** 已进入指令值缓冲的通道。 */
  private chan: Channel | null = null;
  private value = "";
  /** 闭标签未决片段（"<"、"</ex" 等）。 */
  private closing: string | null = null;

  /** 喂入一段流式增量，返回本次解析出的事件。 */
  push(delta: string): DirectiveEvent[] {
    const out: DirectiveEvent[] = [];
    const emitText = (): void => {
      if (!this.text) return;
      const hold = entityTail(this.text);
      const ready = hold === -1 ? this.text : this.text.slice(0, hold);
      this.text = hold === -1 ? "" : this.text.slice(hold);
      if (!ready) return;
      const decoded = decodeEntities(ready);
      const last = out[out.length - 1];
      if (last && last.kind === "text") {
        last.text += decoded;
      } else {
        out.push({ kind: "text", text: decoded });
      }
    };

    for (const ch of delta) {
      // 闭标签匹配中：逐字对齐 `</chan>`，失配则片段退回指令值。
      if (this.closing !== null) {
        const want = `</${this.chan}>`;
        if (ch === want[this.closing.length]) {
          this.closing += ch;
          if (this.closing === want) {
            emitText();
            const v = this.value;
            out.push(
              this.chan === "exp"
                ? { kind: "exp", name: v }
                : { kind: "motion", id: v },
            );
            this.chan = null;
            this.value = "";
            this.closing = null;
          }
          continue;
        }
        // 失配：已匹配的 "</ex" 片段属于指令值；当前字符重新按值处理。
        this.value += this.closing;
        this.closing = null;
        if (ch === "<") {
          this.closing = "<";
        } else {
          this.value += ch;
        }
        if (this.value.length > MAX_VALUE_LEN) {
          // 超长未闭合：整段按字面文本吐回；起了一半的 "<" 转入开标签判定。
          this.text += `<${this.chan}>${this.value}`;
          this.chan = null;
          this.value = "";
          this.open = this.closing === "<" ? "<" : null;
          this.closing = null;
        }
        continue;
      }

      // 指令值收集中：遇 "<" 试配闭标签。
      if (this.chan !== null) {
        if (ch === "<") {
          this.closing = "<";
        } else {
          this.value += ch;
          if (this.value.length > MAX_VALUE_LEN) {
            // 超长未闭合：整段按字面文本吐回。
            this.text += `<${this.chan}>${this.value}`;
            this.chan = null;
            this.value = "";
          }
        }
        continue;
      }

      // 开标签匹配中：逐字对齐 "<exp>" / "<motion>"，失配退回文本。
      if (this.open !== null) {
        const next = this.open + ch;
        const hit = OPEN_TAGS.find(([tag]) => tag === next);
        if (hit) {
          emitText();
          this.chan = hit[1];
          this.open = null;
        } else if (OPEN_TAGS.some(([tag]) => tag.startsWith(next))) {
          this.open = next;
        } else if (ch === "<") {
          // "<" 重启一轮（如 "<<"）；前面的片段按文本。
          this.text += this.open;
          this.open = "<";
        } else {
          this.text += next;
          this.open = null;
        }
        continue;
      }

      if (ch === "<") {
        this.open = "<";
      } else {
        this.text += ch;
      }
    }
    emitText();
    return out;
  }

  /** 流结束：未闭合标记一律退化为字面文本。 */
  flush(): DirectiveEvent[] {
    if (this.open !== null) {
      this.text += this.open;
      this.open = null;
    }
    if (this.chan !== null) {
      this.text += `<${this.chan}>${this.value}${this.closing ?? ""}`;
      this.chan = null;
      this.value = "";
      this.closing = null;
    }
    if (!this.text) return [];
    const text = decodeEntities(this.text);
    this.text = "";
    return [{ kind: "text", text }];
  }
}
