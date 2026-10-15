"""上下文压缩：后台把最旧若干完整回合折叠成摘要（state.summary）。

- 触发：回合结束落盘后，上一回合 usage.prompt_tokens ≥ 阈值 → daemon 线程，
  不占回合一拍（摘要就绪前上下文仍按窗口截断，用户无感）。
- 折叠单位是完整 user→assistant 对：一次折掉最旧 ~一半；已有摘要随新段滚入。
- 单飞：非阻塞锁保证同时至多一个压缩任务；失败静默（下回合重试）。
- 竞态：写回走 store.update_state 锁内 read-modify-write，仅当 history
  前缀仍是当初快照的折叠段时才替换——期间被 load/append 动过就放弃。
"""
from __future__ import annotations

from threading import Lock, Thread
from typing import Any

from .. import llm, store

# ~64k 窗口的 70%：在真正撑爆上下文之前压一轮
COMPRESS_TOKEN_THRESHOLD = 45_000
# 每次折叠历史最旧的一半（按完整回合取整为偶数条）
_FOLD_RATIO = 0.5

_lock = Lock()

_PROMPT = (
    "你是对话记录整理器。把给出的对话压缩成一段连贯摘要，保留关键事实、约定、"
    "未完成的请求与人物关系；只输出摘要正文，不要任何前后缀。"
)


def maybe_compress(prompt_tokens: Any) -> bool:
    """回合末调用：用量达阈值且无任务在跑 → 起后台线程。返回是否已启动。"""
    try:
        tokens = int(prompt_tokens or 0)
    except (TypeError, ValueError):
        tokens = 0
    if tokens < COMPRESS_TOKEN_THRESHOLD:
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
    state = store.normalize_state(store.read_state())
    history = [m for m in (state.get("history") or []) if isinstance(m, dict)]
    fold_n = _fold_count(history)
    if fold_n < 2:
        return False
    seg = history[:fold_n]
    llm_cfg = (state.get("settings") or {}).get("llm") or {}
    old_summary = str(state.get("summary") or "").strip()

    lines = [f"{m.get('role')}: {m.get('text') or ''}" for m in seg]
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
    if not new_summary:
        return False

    def _mutate(st: dict[str, Any]) -> bool:
        cur = list(st.get("history") or [])
        # 压缩期间被 load/追加截断动过前缀 → 放弃（下回合基于新 history 重试）
        if cur[:fold_n] != seg:
            return False
        st["history"] = cur[fold_n:]
        st["summary"] = new_summary
        return True

    return bool(store.update_state(_mutate))
