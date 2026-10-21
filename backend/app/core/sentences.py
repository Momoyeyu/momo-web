"""流式切句：把 LLM 增量输出切成「可朗读的句子」+ 句内指令。

**唯一口径**：切句只在这里做一次（前端原来的 `chat/sentences.ts` 已删）。
后端既能真流式（逐 token 喂），也能整段喂（非流式调用时一次 push 全文），
两种喂法结果必须一致 —— 有专门的测试断言这条性质。

边界规则（见本文件底部的边界规则说明）：

    强边界    。！？!? 与换行；英文句点单独判定（见 _period_breaks）
    弱边界    ，、；;：: 与 …  —— 仅当**当前句已达 weak_min_len**才断，
              它是「这句太长了」的安全阀，不是默认切点
    不拆区    「」『』“”‘’（）()【】[] 与成对 *（动作标注）内部一律不断，按嵌套深度计
    硬上限    达到 hard_max_len 强制断句，避免超长段拖垮 TTS 与字幕
    合并      连写强标点（……、？！）并入上一句，不单独成句

取舍：断句点要**看到下一个字符**才封句（下一个字符若是标点/收尾引号，就连着一起收）。
代价是每句晚一个 token 落账（几十毫秒）；换来的是「同一段文本按任意粒度分片喂入，
结果必须一致」这条性质 —— 没有它，流式切句会随分片边界抖出不同结果。

ACT 控制在切句前剥离，记录纯台词码点位置；字幕与语音不含控制内容。
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from .performance import ActStream

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
@dataclass(frozen=True)
class Cue:
    offset: int
    payload: dict


@dataclass
class Sentence:
    """一个可朗读单元：剥离指令后的正文 + 句内指令。"""

    text: str
    cues: list[Cue] = field(default_factory=list)


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
        self._act = ActStream()
        self._acc = ""  # 已剥离指令、尚未成句的正文
        self._cues: list[Cue] = []  # 正文上的指令（offset 相对 _acc 起点）
        self._stack: list[str] = []  # 成对符号嵌套状态
        self._star = False

    # ---------- 对外 ----------

    def push(self, delta: str) -> list[Sentence]:
        return self._consume(self._act.push(delta))

    def _consume(self, tokens: list[str | dict]) -> list[Sentence]:
        out = []
        for token in tokens:
            if isinstance(token, str):
                out.extend(self._feed(token))
            else:
                self._cues.append(Cue(offset=len(self._acc), payload=token))
        return out

    def flush(self) -> list[Sentence]:
        out = self._consume(self._act.flush())
        out.extend(self._drain(final=True))
        if self._cues:
            out.append(Sentence(text='', cues=[replace(c, offset=0) for c in self._cues]))
            self._cues = []
        return out

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
        mine: list[Cue] = []
        keep: list[Cue] = []
        for d in self._cues:
            if d.offset < pos:
                mine.append(replace(d, offset=max(0, d.offset - lead)))
            else:
                keep.append(replace(d, offset=d.offset - pos))
        self._cues = keep
        self._acc = self._acc[pos:]
        # 断句后重置嵌套状态：未闭合的引号不应永久压制断句
        self._stack = []
        self._star = False
        if not text:
            return Sentence(text="", cues=[replace(c, offset=0) for c in mine]) if mine else None
        return Sentence(text=text, cues=[d for d in mine if d.offset <= len(text)])


def split_sentences(text: str) -> list[Sentence]:
    """整段切句（测试与离线校验用）；结果与逐块 push + flush 完全一致。"""
    st = SentenceStream()
    out = st.push(text)
    out.extend(st.flush())
    return out
