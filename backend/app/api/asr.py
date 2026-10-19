"""/api/asr：内置 ASR（SenseVoice）的状态查询与实时流。

WS 协议（前端 `asrClient` 的 builtin 引擎按此实现）：
    上行：二进制 = s16le 16kHz mono PCM 帧；文本 = {"type":"finalize"|"close"}
    下行：{"type":"ready"} | {"type":"speech_started"}
          | {"type":"transcript","text":"..."}
          | {"type":"finalized"} | {"type":"error","message":"..."}

为什么不用 Deepgram 那套事件名：那套协议已经退役（自定义 ASR 改走 OpenAI
HTTP 协议），内置端点是自有的最小协议，事件语义只有三个：开始说话、
一段话的最终文本、错误。
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..core.state import load
from ..services import asr
from ..services.prompt import conversation_lang

router = APIRouter()


@router.get("/api/asr/status")
def asr_status() -> dict[str, Any]:
    """内置引擎状态：ready=false 时 missing 列出缺失文件。"""
    return asr.status(conversation_lang(load()))


@router.websocket("/api/asr/stream")
async def asr_stream(ws: WebSocket) -> None:
    await ws.accept()
    lang = conversation_lang(load())
    try:
        session = await asyncio.to_thread(asr.AsrSession, lang)
    except asr.AsrError as e:
        await ws.send_json({"type": "error", "message": str(e)})
        await ws.close()
        return

    await ws.send_json({"type": "ready", "language": asr.status(lang)["language"]})
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            chunk = msg.get("bytes")
            if chunk:
                for ev in await asyncio.to_thread(session.feed, chunk):
                    await ws.send_json(ev)
                continue
            text = msg.get("text")
            if not text:
                continue
            try:
                cmd = json.loads(text).get("type")
            except (ValueError, AttributeError):
                cmd = None
            if cmd == "finalize":
                for ev in await asyncio.to_thread(session.flush):
                    await ws.send_json(ev)
                await ws.send_json({"type": "finalized"})
            elif cmd == "close":
                # 收尾后主动断开：客户端不需要再等
                for ev in await asyncio.to_thread(session.flush):
                    await ws.send_json(ev)
                break
    except WebSocketDisconnect:
        pass
    finally:
        try:
            await ws.close()
        except RuntimeError:
            pass
