"""POST /api/chat：SSE 端点（ReAct 在 agent.py）。

事件格式：`data: {...}\n\n`，事件见 docs/backend-api.md。
成功回合末尾发 {"t":"done"}；失败发 {"t":"error"} 后直接结束（不发 done）。
"""
from __future__ import annotations

import json
from typing import Any, Iterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import agent

router = APIRouter()


class ChatIn(BaseModel):
    text: str


def _sse(ev: dict[str, Any]) -> str:
    return f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"


@router.post("/api/chat")
def chat(req: ChatIn) -> StreamingResponse:
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="empty text")

    def stream() -> Iterator[str]:
        errored = False
        try:
            for ev in agent.run_turn(req.text):
                if ev.get("t") == "error":
                    errored = True
                yield _sse(ev)
        except Exception as e:  # 兜底：agent 未捕获的异常也走 error 事件
            errored = True
            yield _sse({"t": "error", "message": str(e), "service": "backend"})
        if not errored:
            yield _sse({"t": "done"})

    return StreamingResponse(stream(), media_type="text/event-stream")
