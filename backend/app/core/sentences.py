"""流式切句：把 LLM 增量输出切成「可朗读的句子」+ 句内指令。

**唯一口径**：切句只在这里做一次（前端原来的 `chat/sentences.ts` 已删）。
后端既能真流式（逐 token 喂），也能整段喂（非流式调用时一次 push 全文），
两种喂法结果必须一致 —— 有专门的测试断言这条性质。

边界规则（docs/sentences-plan.md §3）：

    强边界    。！？!? 与换行；英文句点单独判定（见 _period_breaks）
    弱边界    ，、；;：: 与 …  —— 仅当**当前句已达 weak_min_len**才断，
              它是「这句太长了」的安全阀，不是默认切点
    不拆区    「」『』“”‘’（）()【】[] 与成对 *（动作标注）内部一律不断，按嵌套深度计
    硬上限    达到 hard_max_len 强制断句，避免超长段拖垮 TTS 与字幕
    合并      连写强标点（……、？！）并入上一句，不单独成句

指令：`<exp>名称</exp>` / `<motion>名称</motion>` 视为**原子 token** —— 不参与边界
判断、不进入正文，但记录它在所属句子正文里的偏移，随句一起产出（前端据此在
字幕推进到该偏移时触发）。畸形/未闭合标记退化为字面文本，不吃掉正文。
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

#: 强边界：遇即断句（英文句点单独判定）。
STRONG = set("。！？!?\n")
#: 弱边界：语气停顿，只在句子已经偏长时才作为安全阀断开。
WEAK = set("，、；;：:…")
#: 成对符号：进入内部后弱边界失效（按住嵌套深度）。
PAIRS = {"「": "」", "『": "』", "“": "”", "‘": "’", "（": "）", "(": ")", "【": "】", "[": "]"}
CLOSERS = set(PAIRS.values())
#: 动作标注 *…*（开闭同符，用开关状态计）。
STAR = "*"
#: 所有标点（判定「这句只有标点」时用）。
PUNCT = STRONG | WEAK | set("」』”’。.,")

#: 弱边界生效所需的最小句长。「拆得太细」的直接旋钮：调大 = 更愿意攒成一句。
WEAK_MIN_LEN = 60
#: 硬上限：超过即强制断句。
HARD_MAX_LEN = 200
#: 指令名长度上限，超出按畸形处理（防止未闭合标记吃掉整段）。
MAX_VALUE_LEN = 64

_OPEN_TAGS = ("<exp>", "<motion>")


@dataclass(frozen=True)
class Dir:
    """句子携带的指令：kind 为 exp/motion，offset 是它在句子正文里的位置。"""

    kind: str
    name: str
    offset: int


@dataclass
class Sentence:
    """一个可朗读单元：剥离指令后的正文 + 句内指令。"""

    text: str
    dirs: list[Dir] = field(default_factory=list)


def _period_breaks(acc: str, i: int) -> bool | None:
    """英文句点是否断句。True/False 明确，None 表示「还需后续字符才能判断」。

    规则刻意从简（不引入缩写词典）：前一个字符不是数字，且其后是
    空白 + 大写/引号/结尾，或直接跟大写字母/引号/非拉丁字符。
    """
    if i > 0 and acc[i - 1].isdigit():
        return False
    nxt = acc[i + 1 :]
    if not nxt:
        return None  # 最后一个字符是 "."：等下个增量（flush 时按结尾收尾）
    j = 0
    while j < len(nxt) and nxt[j] in " \t":
        j += 1
    if j >= len(nxt):
        return None if len(nxt) < 8 else True  # 后面只剩空白：等一会儿，等太久就先断
    after = nxt[j]
    if after.isupper() or after in CLOSERS or after in "\"'":
        return True
    if not after.isascii():
        return True  # 中日文没有大小写：句点后跟汉字假名也算新句
    return False


class SentenceStream:
    """增量喂入原始文本（含指令），产出成句。"""

    def __init__(
        self, weak_min_len: int = WEAK_MIN_LEN, hard_max_len: int = HARD_MAX_LEN
    ) -> None:
        self.weak_min_len = weak_min_len
        self.hard_max_len = hard_max_len
        self._raw = ""  # 未 tokenize 的原始尾部（可能是半个标签）
        self._acc = ""  # 已剥离指令、尚未成句的正文
        self._dirs: list[Dir] = []  # 正文上的指令（offset 相对 _acc 起点）
        self._stack: list[str] = []  # 成对符号嵌套状态
        self._star = False

    # ---------- 对外 ----------

    def push(self, delta: str) -> list[Sentence]:
        """喂入一段增量，返回本次成句的句子（0..n 个）。"""
        if not delta:
            return []
        self._raw += delta
        out = self._take_directives()
        out.extend(self._drain(final=False))
        return out

    def flush(self) -> list[Sentence]:
        """流结束：把残余（含未闭合指令、未断句尾部）一次吐净。"""
        out = self._take_directives()
        if self._raw:
            self._acc += self._raw  # 未闭合的标记退化为字面正文
            self._raw = ""
        out.extend(self._drain(final=True))
        return out

    # ---------- 指令 token 化 ----------

    def _take_directives(self) -> list[Sentence]:
        """从 _raw 里摘出完整指令；返回期间顺带成句的句子。"""
        out: list[Sentence] = []
        while True:
            hit = self._find_open_tag(self._raw)
            if hit is None:
                break
            start, kind, after = hit
            end = self._raw.find(f"</{kind}>", after)
            if end == -1:
                if len(self._raw) - after > MAX_VALUE_LEN:
                    break  # 值超长：当畸形，整个按正文处理（见下方 _safe_cut）
                out.extend(self._feed(self._raw[:start]))
                self._raw = self._raw[start:]  # 留到后续增量再配闭标签
                return out
            out.extend(self._feed(self._raw[:start]))
            self._dirs.append(
                Dir(kind=kind, name=self._raw[after:end], offset=len(self._acc))
            )
            self._raw = self._raw[end + len(kind) + 3 :]
        cut = self._safe_cut(self._raw)
        if cut:
            out.extend(self._feed(self._raw[:cut]))
            self._raw = self._raw[cut:]
        return out

    @staticmethod
    def _find_open_tag(s: str) -> tuple[int, str, int] | None:
        """找最早的完整开标签，返回 (起点, kind, 值起点)。"""
        best: tuple[int, str, int] | None = None
        for tag in _OPEN_TAGS:
            i = s.find(tag)
            if i != -1 and (best is None or i < best[0]):
                best = (i, tag[1:-1], i + len(tag))
        return best

    @staticmethod
    def _safe_cut(s: str) -> int:
        """可安全交给正文的长度：末尾可能是标签前缀的部分留到下次。"""
        if not s:
            return 0
        i = s.rfind("<")
        if i == -1:
            return len(s)
        tail = s[i:]
        if any(t.startswith(tail) for t in _OPEN_TAGS):
            return i
        return len(s)

    # ---------- 正文切句 ----------

    def _feed(self, text: str) -> list[Sentence]:
        if not text:
            return []
        self._acc += text
        return self._drain(final=False)

    def _drain(self, final: bool) -> list[Sentence]:
        out: list[Sentence] = []
        i = 0
        while i < len(self._acc):
            ch = self._acc[i]
            if ch in PAIRS:
                self._stack.append(PAIRS[ch])
                i += 1
                continue
            if ch in CLOSERS:
                if self._stack and self._stack[-1] == ch:
                    self._stack.pop()
                i += 1
                continue
            if ch == STAR:
                self._star = not self._star
                i += 1
                continue

            verdict = self._boundary_at(i)
            if verdict is None:
                break  # 需更多字符才能判断（如句末的 "."），留到下次
            if verdict:
                # 断句点后可能还有连写标点或收尾引号（？！、……、」。）：
                # **必须看到下一个字符才决定**，否则同一段文本按不同粒度喂入
                # 会切出不同结果（这是流式切句的正确性底线）。
                if i + 1 >= len(self._acc):
                    if not final:
                        break  # 边界正好在缓冲末尾：留到下个增量
                elif self._acc[i + 1] in PUNCT:
                    i += 1  # 连写：把断点让给后面那个标点
                    continue
                s = self._seal(i + 1)
                if s is None:
                    break  # 整段都是标点：留着与后续正文合并
                out.append(s)
                i = 0
                continue
            i += 1

        # 硬上限：可循环触发多次
        while not final and len(self._acc) >= self.hard_max_len:
            s = self._seal(self.hard_max_len)
            if s is None:
                break
            out.append(s)

        if final:
            s = self._seal(len(self._acc))
            if s is not None:
                out.append(s)
        return out

    def _boundary_at(self, i: int) -> bool | None:
        """位置 i 的字符是否构成断句点。None = 还不能判断。"""
        ch = self._acc[i]
        if ch == ".":
            return _period_breaks(self._acc, i)
        if ch in STRONG:
            return True
        if ch in WEAK:
            if self._stack or self._star:
                return False  # 引号/括号/动作标注内部不断
            return i + 1 >= self.weak_min_len
        return False

    def _seal(self, pos: int) -> Sentence | None:
        """把 _acc[:pos] 封成一句；指令按偏移归入，剩余部分留待下一句。"""
        head = self._acc[:pos]
        text = head.strip()
        lead = len(head) - len(head.lstrip())
        mine: list[Dir] = []
        keep: list[Dir] = []
        for d in self._dirs:
            if d.offset < pos:
                mine.append(replace(d, offset=max(0, d.offset - lead)))
            else:
                keep.append(replace(d, offset=d.offset - pos))
        self._dirs = keep
        self._acc = self._acc[pos:]
        # 断句后重置嵌套状态：未闭合的引号不应永久压制断句
        self._stack = []
        self._star = False
        if not text:
            return None
        return Sentence(text=text, dirs=[d for d in mine if d.offset <= len(text)])


def split_sentences(text: str) -> list[Sentence]:
    """整段切句（非流式路径与测试用）；与逐块 push 结果一致。"""
    st = SentenceStream()
    out = st.push(text)
    out.extend(st.flush())
    return out
