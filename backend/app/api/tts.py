"""/api/tts：TTS 合成代理（前端按 OpenAI 形状说话，后端翻译成 GPT-SoVITS）。

    POST /api/tts/speech  {input, lang?} → audio/pcm 流
                         响应头 X-Sample-Rate = 实际采样率（前端据此建 AudioContext）
    POST /api/tts/ref     上传参考音频（multipart，重复上传覆盖）
    GET  /api/tts/status  → 配置与上游可达性（设置页「测试」用）
"""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..services import tts
from ..services.prompt import conversation_lang
from ..core.state import load

router = APIRouter()


class SpeechIn(BaseModel):
    input: str
    lang: str | None = None


@router.post("/api/tts/speech")
async def speech(body: SpeechIn) -> StreamingResponse:
    if not body.input.strip():
        raise HTTPException(status_code=400, detail="input 为空")
    lang = body.lang or conversation_lang(load())
    try:
        sample_rate, chunks = await tts.synthesize(body.input, lang)
    except tts.TtsError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return StreamingResponse(
        chunks,
        media_type="audio/pcm",
        headers={
            "X-Sample-Rate": str(sample_rate),
            "Cache-Control": "no-store",
        },
    )


@router.post("/api/tts/ref")
async def upload_ref(file: UploadFile = File(...)) -> dict:
    """上传参考音频。重复上传覆盖旧文件（state 里只记文件名）。"""
    data = await file.read()
    try:
        info = tts.save_ref(file.filename or "", data)
    except tts.TtsError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, **info}


@router.get("/api/tts/status")
async def status() -> dict:
    return await tts.status()
