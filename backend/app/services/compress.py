"""上下文压缩：后台把最旧若干完整回合折叠成摘要（sessions.live.summary）。

- 触发：回合结束落盘后，上一回合 usage.prompt_tokens ≥ 阈值 → daemon 线程，
  不占回合一拍（摘要就绪前上下文仍按窗口截断，用户无感）。
- 折叠单位是完整 user→assistant 对：一次折掉最旧 ~一半；已有摘要随新段滚入。
- 单飞：非阻塞锁保证同时至多一个压缩任务；失败静默（下回合重试）。
- 竞态：写回在一个事务里校验 live.generation 未变（期间 load/打断
  换过会话就放弃折叠）推进 summary_cursor + 写 summary；账本原文永久保留。
"""

from __future__ import annotations

from threading import Lock, Thread
from typing import Any

from ..core import llm
from ..core import db
from ..core.state import load as load_state
from ..core.db import LIVE_ID

# ~64k 窗口的 70%：在真正撑爆上下文之前压一轮
COMPRESS_TOKEN_THRESHOLD = 45_000
# 每次折叠历史最旧的一半（按完整回合取整为偶数条）
_FOLD_RATIO = 0.5

_lock = Lock()

_PROMPT = (
    "You compress conversation logs into one coherent summary. Keep key facts, "
    "agreements, unfinished requests and relationships between characters. "
    "Write the summary in the language the conversation is in. "
    "Output the summary body only — no preamble, no postscript."
)


def maybe_compress(prompt_tokens: Any) -> bool:
    """回合末调用：用量达阈值且无任务在跑 → 起后台线程。返回是否已启动。"""
    try:
        tokens = int(prompt_tokens or 0)
    except (TypeError, ValueError):
        tokens = 0
    if tokens < COMPRESS_TOKEN_THRESHOLD:
        from . import checkpoint

        # A bounded recent window no longer reaches the old token threshold.
        # Summarize observed history before it falls outside that window.
        if len(checkpoint.context_rows(limit=41)) < 40:
            return False
    if not _lock.acquire(blocking=False):
        return False  # 单飞：已有压缩在跑
    Thread(target=_worker, daemon=True).start()
    return True


def _worker() -> None:
    try:
        compress_once()
    except Exception:
        pass  # 静默：压缩失败不影响对话，下回合再试
    finally:
        _lock.release()


def _fold_count(history: list[Any]) -> int:
    """折叠段条数：最旧 ~一半，向下取到完整回合（偶数条，含 user+assistant）。"""
    n = int(len(history) * _FOLD_RATIO)
    if n % 2:
        n -= 1
    return max(n, 0)


def compress_once() -> bool:
    """同步压缩一次（后台 worker 与测试共用）。成功写回 → True。"""
    state = load_state()
    from . import checkpoint

    snapshot = checkpoint.summary_state()
    gen_n = snapshot["generation"]
    old_summary = str(snapshot["summary"] or "").strip()
    history = checkpoint.context_rows()
    fold_n = _fold_count(history)
    # End only at an explicit run boundary, never in a multi-sentence reply.
    while (
        fold_n > 0
        and fold_n < len(history)
        and history[fold_n - 1]["run_id"] == history[fold_n]["run_id"]
    ):
        fold_n -= 1
    if fold_n < 2:
        return False
    seg = history[:fold_n]
    llm_cfg = state["settings"]["llm"]

    lines = [f"{m['role']}: {m['text']}" for m in seg]
    if old_summary:
        user = (
            f"已有摘要：\n{old_summary}\n\n"
            "把下面的新对话并入，输出更新后的完整摘要：\n" + "\n".join(lines)
        )
    else:
        user = "把下面的对话压缩成摘要：\n" + "\n".join(lines)
    msg = llm.chat_completion(
        llm_cfg,
        [
            {"role": "system", "content": _PROMPT},
            {"role": "user", "content": user},
        ],
    )
    new_summary = str(msg.get("content") or "").strip()
    if not new_summary or len(new_summary) > 6000:
        return False

    max_seq = seg[-1]["seq"]
    with db.tx() as c:
        cur = c.execute(
            "SELECT generation,summary_version,summary_cursor FROM sessions WHERE id=?",
            (LIVE_ID,),
        ).fetchone()
        # 压缩期间 load/打断换过会话 → 放弃（下回合基于新上下文重试）
        if (
            cur is None
            or int(cur["generation"]) != gen_n
            or int(cur["summary_version"]) != snapshot["version"]
            or int(cur["summary_cursor"]) != snapshot["cursor"]
        ):
            return False
        c.execute(
            "UPDATE sessions SET summary=?,summary_cursor=?,summary_version=summary_version+1 WHERE id=?",
            (new_summary, max_seq, LIVE_ID),
        )
    return True
