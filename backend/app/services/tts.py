"""TTS 适配层：把前端的 OpenAI 形状请求翻译成 GPT-SoVITS api_v2 调用。

为什么要有这层：GPT-SoVITS 的接口是 `POST /tts` + 一堆自描述参数（参考音频、
参考文本、text_lang/prompt_lang、media_type、streaming_mode），不是 OpenAI 形状；
它还返回 wav 头 + PCM 的混合流。把这些差异收在 backend，前端只按 OpenAI 形状
（`POST /api/tts/speech`，`audio/pcm`）说话——将来换引擎也只改这里。

参考音频走**上传**（`POST /api/tts/ref`），存到 data 目录；合成时以 base64
（api_v2 的 `ref_audio` 字段）随请求发给上游。这样：
- 用户不需要在别的机器上摆文件、填路径；
- GPT-SoVITS 可以跑在另一台机器，不要求与本机共享文件系统；
- 重复上传覆盖旧文件，state 里只记文件名。
前提：GPT-SoVITS api_v2 需支持 `ref_audio`（官方版只认服务端本地路径
`ref_audio_path`，base64 需上游带该支持——本仓库的部署已打补丁：
`_materialize_ref_audio` 把 base64 落临时文件再走原链路）。

流式细节（对照 api_v2.py）：
- `streaming_mode=true` 时服务端先吐一个 44 字节 WAV 头，之后全是裸 PCM；
- 头里带真实采样率（v2 32k / v4 48k 等），所以这里解析出头再交给前端，
  前端据此配置 AudioContext —— 写死 24k 会变调。
"""
from __future__ import annotations

import base64
import io
import wave
from pathlib import Path

import httpx

from ..core.state import DATA_DIR, load, read_state, write_state
from ..services.prompt import conversation_lang

#: 服务端 wav 头解析失败时的兜底采样率（v2 系列默认 32k）
FALLBACK_SR = 32000
_TIMEOUT = httpx.Timeout(120.0, connect=5.0)
_STATUS_TIMEOUT = httpx.Timeout(3.0)

#: 参考音频落在 data/tts/ 下；重复上传覆盖同前缀文件。
REF_DIR = DATA_DIR / "tts"
REF_STEM = "ref"
MAX_REF_BYTES = 10 * 1024 * 1024  # 10MB：10 秒 32k wav 约 1.3MB，留足余量
REF_EXTS = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac"}


class TtsError(RuntimeError):
    """TTS 未配置或上游失败。"""


def _cfg() -> dict:
    return load()["settings"]["tts"]


def ref_path(cfg: dict | None = None) -> Path | None:
    """已上传的参考音频路径；没上传/文件丢了返回 None。"""
    c = cfg or _cfg()
    name = str(c.get("voice") or "").strip()
    if not name:
        return None
    p = REF_DIR / Path(name).name
    return p if p.is_file() else None


def save_ref(filename: str, data: bytes) -> dict:
    """保存参考音频（覆盖旧文件）并写入 state；返回元信息。"""
    ext = Path(filename or "").suffix.lower()
    if ext not in REF_EXTS:
        raise TtsError(f"不支持的音频格式：{ext or '未知'}（支持 wav/mp3/m4a/flac/ogg/aac）")
    if not data:
        raise TtsError("文件为空")
    if len(data) > MAX_REF_BYTES:
        raise TtsError(f"文件过大（上限 {MAX_REF_BYTES // (1024 * 1024)}MB）")

    # GPT-SoVITS 要求参考音频 3~10 秒：wav 能直接算时长，上传时就拦住，
    # 免得用户配完到合成时才收到一鼻子灰；其他格式留待上游报错。
    if ext == ".wav":
        try:
            with wave.open(io.BytesIO(data), "rb") as w:
                dur = w.getnframes() / w.getframerate()
            if not 3 <= dur <= 10:
                raise TtsError(
                    f"参考音频时长 {dur:.1f} 秒，需在 3~10 秒内（GPT-SoVITS 的硬性要求）"
                )
        except wave.Error:
            pass  # 不是标准 PCM wav：交给上游处理

    # 保留用户的原文件名（去掉目录部分，防路径穿越）；旧文件一律清掉——
    # 参考音频是单槽语义，重复上传即覆盖
    name = Path(filename).name.strip() or f"{REF_STEM}{ext}"
    REF_DIR.mkdir(parents=True, exist_ok=True)
    for old in REF_DIR.iterdir():
        if old.is_file() and old.name != name:
            try:
                old.unlink()
            except OSError:
                pass
    (REF_DIR / name).write_bytes(data)

    raw = read_state() or {}
    settings = dict(raw.get("settings") or {})
    tts_cfg = dict(settings.get("tts") or {})
    tts_cfg["voice"] = name
    settings["tts"] = tts_cfg
    raw["settings"] = settings
    write_state(raw)
    return {"name": name, "size": len(data)}


async def synthesize(text: str, lang: str | None = None):
    """建立合成流，返回 (采样率, 异步 PCM 迭代器)。

    迭代器结束时自动关闭上游连接；上游非 200 → TtsError（带响应体片段）。
    """
    cfg = _cfg()
    base = (cfg.get("url") or "").strip()
    if not base:
        raise TtsError("TTS 未配置")
    ref = ref_path(cfg)
    if ref is None:
        raise TtsError("未上传参考音频")
    language = lang or conversation_lang(load())

    payload = {
        "text": text,
        "text_lang": language,
        # base64 上传：GPT-SoVITS 不必与本机共享文件系统
        "ref_audio": base64.b64encode(ref.read_bytes()).decode("ascii"),
        # 上游按后缀识别容器格式（wav/mp3/…），base64 本身不带文件名
        "ref_audio_name": ref.name,
        "prompt_text": cfg.get("prompt") or "",
        "prompt_lang": language,
        # wav + streaming：先给头（含采样率），后面是裸 PCM
        "media_type": "wav",
        "streaming_mode": True,
        "text_split_method": "cut5",
        "parallel_infer": True,
    }

    client = httpx.AsyncClient(timeout=_TIMEOUT, trust_env=False)
    try:
        req = client.build_request("POST", _endpoint(base), json=payload)
        if cfg.get("key"):
            req.headers["Authorization"] = f"Bearer {cfg['key']}"
        resp = await client.send(req, stream=True)
        if resp.status_code != 200:
            detail = (await resp.aread())[:400].decode("utf-8", "replace")
            await resp.aclose()
            raise TtsError(f"TTS 上游 {resp.status_code}：{detail}")

        # 先把 44 字节 WAV 头读齐（上游可能分多个 chunk 到）
        buf = b""
        it = resp.aiter_raw()
        while len(buf) < 44:
            try:
                buf += await it.__anext__()
            except StopAsyncIteration:
                break
        sample_rate = FALLBACK_SR
        if len(buf) >= 44 and buf[:4] == b"RIFF":
            sample_rate = int.from_bytes(buf[24:28], "little") or FALLBACK_SR
        head_rest = buf[44:] if len(buf) > 44 else b""
    except TtsError:
        await client.aclose()
        raise
    except httpx.HTTPError as e:
        await client.aclose()
        raise TtsError(f"TTS 连接失败：{e}") from e

    async def chunks():
        try:
            if head_rest:
                yield head_rest
            async for chunk in it:
                if chunk:
                    yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return sample_rate, chunks()


async def status() -> dict:
    """设置页「测试」用：配置齐不齐 + 上游可达。"""
    cfg = _cfg()
    base = (cfg.get("url") or "").strip()
    ref = ref_path(cfg)
    out = {
        "engine": "gpt-sovits",
        "configured": bool(base and ref),
        "url": base,
        "reachable": False,
        "hasRef": ref is not None,
        "refName": cfg.get("voice") or "",
        "refSize": ref.stat().st_size if ref else 0,
        "detail": "",
    }
    if not base:
        out["detail"] = "未配置服务地址"
        return out
    if ref is None:
        out["detail"] = "未上传参考音频"
        return out
    try:
        async with httpx.AsyncClient(timeout=_STATUS_TIMEOUT, trust_env=False) as c:
            # api_v2 是 FastAPI：/docs 一定存在且轻量，比打一次真实合成便宜
            r = await c.get(base.rstrip("/") + "/docs")
        out["reachable"] = r.status_code < 500
        out["detail"] = f"HTTP {r.status_code}"
    except httpx.HTTPError as e:
        out["detail"] = f"连接失败：{e.__class__.__name__}"
    return out


def _endpoint(base: str) -> str:
    return base.rstrip("/") + "/tts"
