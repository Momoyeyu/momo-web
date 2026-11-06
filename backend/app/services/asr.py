"""内置 ASR：SenseVoice-Small(int8) + silero VAD，全部在 backend 进程内跑。

设计要点：
- **不做流式解码**。SenseVoice 是非自回归整段模型，实时性靠 VAD 切句：
  音频进来先喂 VAD，检测到"说完一段"就把这段整段识别。对"用户说完一句
  → 模型开始回复"的 VN 对话节奏，这个粒度刚好够用。
- **语言**跟随设置里的对话语言（chatLang）：SenseVoice 支持
  auto/zh/en/ja/ko/yue，我们用 zh/en/ja（其余回落 auto）。
- 安装资源不完整时报告错误；运行时不联网获取模型。
- 所有会话共用一个识别器，语言切换替换该实例；最后一条会话关闭即释放。
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path
from typing import Any

import numpy as np

SAMPLE_RATE = 16000
#: 单段最长 30s（超长由 VAD 自身切分；这里再兜一层，防内存爆）
MAX_SEGMENT_SECONDS = 30.0
VAD_THRESHOLD = 0.5
MIN_SILENCE_SECONDS = 0.45  # 断句灵敏度：太短会把句中停顿切成两句
MIN_SPEECH_SECONDS = 0.2

MODELS_DIR = Path(
    os.environ.get("MOMO_ASR_MODELS")
    or (Path(os.environ["MOMO_RESOURCES_DIR"]) / "asr" if os.environ.get("MOMO_RESOURCES_DIR")
        else Path(__file__).resolve().parents[2] / "models" / "asr")
)
SENSE_DIR = MODELS_DIR / "sense-voice"
MODEL_PATH = SENSE_DIR / "model.int8.onnx"
TOKENS_PATH = SENSE_DIR / "tokens.txt"
VAD_PATH = MODELS_DIR / "silero_vad.onnx"

#: chatLang → SenseVoice 语言码。ko/yue 暂不暴露（设置里只有中日英）。
_LANG = {"zh": "zh", "en": "en", "ja": "ja"}


class AsrError(RuntimeError):
    """内置 ASR 不可用（模型缺失/加载失败）。"""


def _ensure_onnxruntime_lib() -> None:
    """Preflight native libraries; packaged wheels must be usable as installed.

    The compatibility repair is restricted to a writable development virtualenv
    and discovers installed packages rather than assuming backend/.venv layout.
    Offline releases must pass native smoke tests during their platform build.
    """
    try:
        import sherpa_onnx  # noqa: F401
        return
    except ImportError as original:
        import importlib.metadata
        import sys
        if sys.prefix != sys.base_prefix:
            try:
                sherpa = importlib.metadata.distribution("sherpa-onnx")
                ort = importlib.metadata.distribution("onnxruntime")
                target = Path(sherpa.locate_file("sherpa_onnx/lib/libonnxruntime.dylib"))
                candidates = list(Path(ort.locate_file("onnxruntime/capi")).glob("libonnxruntime*.dylib"))
                if target.parent.is_dir() and candidates and not target.exists():
                    target.write_bytes(candidates[0].read_bytes())
                    import sherpa_onnx  # noqa: F401
                    return
            except (ImportError, OSError, importlib.metadata.PackageNotFoundError):
                pass
        raise AsrError(f"内置语音运行库不可用：{original}") from original


def missing_models() -> list[str]:
    """Missing/truncated model files; cheap status check, no model hashing."""
    need = {"sense-voice/model.int8.onnx": (MODEL_PATH, 239233841),
            "sense-voice/tokens.txt": (TOKENS_PATH, 315894),
            "silero_vad.onnx": (VAD_PATH, 1807522)}
    unavailable = []
    for name, (path, expected_size) in need.items():
        try:
            if not path.is_file() or path.stat().st_size != expected_size:
                unavailable.append(name)
        except OSError:
            unavailable.append(name)
    return unavailable


def ready() -> bool:
    return not missing_models()


# A single model remains resident even with multiple languages/sessions. All
# allocation and decoding use the same lock, so language changes cannot allocate
# duplicate recognizers concurrently.
_recognizers: dict[str, Any] = {}
_rec_lock = threading.RLock()
_active_sessions = 0
_integrity_stamp: tuple | None = None


def _verify_models() -> None:
    """Hash at session start only when file metadata changes, never per frame."""
    global _integrity_stamp
    manifest_path = Path(__file__).resolve().parents[2] / "resources" / "asr" / "manifest.json"
    if os.environ.get("MOMO_RESOURCES_DIR") and not os.environ.get("MOMO_ASR_MODELS"):
        manifest_path = MODELS_DIR / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text())
        required = {"sense-voice/model.int8.onnx", "sense-voice/tokens.txt", "silero_vad.onnx"}
        entries = [entry for entry in manifest["files"] if entry["path"] in required]
        if {entry["path"] for entry in entries} != required or len(entries) != len(required):
            raise ValueError("Incomplete model manifest")
        files = [(MODELS_DIR / entry["path"], entry) for entry in entries]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise AsrError("内置语音资源清单缺失或损坏，请修复安装") from exc
    try:
        stamp = ((str(manifest_path), manifest_path.stat().st_mtime_ns),) + tuple(
            (str(path), path.stat().st_size, path.stat().st_mtime_ns) for path, _ in files)
        if stamp == _integrity_stamp:
            return
        for path, entry in files:
            if path.stat().st_size != entry.get("size_bytes"):
                raise AsrError(f"内置语音资源损坏：{entry['path']}")
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest != entry.get("sha256"):
                raise AsrError(f"内置语音资源损坏：{entry['path']}")
    except OSError as exc:
        raise AsrError(f"内置语音资源缺失：{exc.filename}") from exc
    _integrity_stamp = stamp


def _recognizer(lang: str) -> Any:
    """Return the sole resident recognizer, replacing it on language changes."""
    code = _LANG.get(lang, "auto")
    with _rec_lock:
        rec = _recognizers.get(code)
        if rec is not None:
            return rec
        _recognizers.clear()  # release old model before allocating its replacement
        try:
            _ensure_onnxruntime_lib()
            import sherpa_onnx

            rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(MODEL_PATH),
                tokens=str(TOKENS_PATH),
                num_threads=2,
                use_itn=True,
                language=code,
            )
        except Exception as e:
            raise AsrError(f"识别器加载失败：{e}") from e
        _recognizers[code] = rec
        return rec


def _vad() -> Any:
    _ensure_onnxruntime_lib()
    import sherpa_onnx

    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = str(VAD_PATH)
    cfg.silero_vad.threshold = VAD_THRESHOLD
    cfg.silero_vad.min_silence_duration = MIN_SILENCE_SECONDS
    cfg.silero_vad.min_speech_duration = MIN_SPEECH_SECONDS
    cfg.silero_vad.window_size = 512
    cfg.sample_rate = SAMPLE_RATE
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=MAX_SEGMENT_SECONDS)


class AsrSession:
    """一条语音输入会话：喂 PCM 帧，吐出内部事件。

    事件形状（与前端约定）：
        {"type": "speech_started"}             VAD 判定开始说话（barge-in 用）
        {"type": "transcript", "text": "..."}  一段话的最终识别结果
    """

    def __init__(self, lang: str) -> None:
        if not ready():
            raise AsrError("模型缺失：" + ", ".join(missing_models()))
        global _active_sessions
        self._closed = True
        self._lang = _LANG.get(lang, "auto")
        self._speaking = False
        with _rec_lock:
            _verify_models()
            self._vad = _vad()
            try:
                _recognizer(self._lang)
            except Exception:
                self._vad = None
                raise
            _active_sessions += 1
            self._closed = False
        # int16 分帧残留（VAD 内部按 512 窗口处理，这里只需保证样本连续）
        self._carry = np.zeros(0, dtype=np.float32)

    def close(self) -> None:
        """Release VAD and, after the final session, the shared recognizer."""
        global _active_sessions
        with _rec_lock:
            if self._closed:
                return
            self._closed = True
            self._vad = None
            self._carry = np.zeros(0, dtype=np.float32)
            _active_sessions -= 1
            if _active_sessions == 0:
                _recognizers.clear()

    # ---- 音频入口 ----

    def feed(self, pcm: bytes) -> list[dict[str, str]]:
        """喂一帧 s16le 16k mono，返回本帧产生的零到多个事件。"""
        if self._closed:
            raise AsrError("语音会话已关闭")
        if not pcm:
            return []
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        if self._carry.size:
            samples = np.concatenate([self._carry, samples])
            self._carry = np.zeros(0, dtype=np.float32)
        return self._consume(samples)

    def flush(self) -> list[dict[str, str]]:
        """收尾：把 VAD 里没吐完的尾段强制吐出来（用户松手/断连时调用）。"""
        if self._closed:
            return []
        events: list[dict[str, str]] = []
        self._vad.flush()
        events.extend(self._drain_segments())
        self._speaking = False
        return events

    # ---- 内部 ----

    def _consume(self, samples: np.ndarray) -> list[dict[str, str]]:
        events: list[dict[str, str]] = []
        # VAD 需要定长窗口；按 window_size 切，剩余留到下一帧
        win = 512
        n = samples.size
        usable = n - (n % win)
        for start in range(0, usable, win):
            self._vad.accept_waveform(samples[start : start + win])
            now = self._vad.is_speech_detected()
            if now and not self._speaking:
                self._speaking = True
                events.append({"type": "speech_started"})
            elif not now:
                self._speaking = False
        if n > usable:
            self._carry = samples[usable:]
        events.extend(self._drain_segments())
        return events

    def _drain_segments(self) -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        while not self._vad.empty():
            seg = self._vad.front
            # 必须先取 samples 再 pop：pop() 会释放段内数据（实测读出来是空列表）
            samples = np.asarray(list(seg.samples), dtype=np.float32)
            self._vad.pop()
            text = self._transcribe(samples).strip()
            if text:
                out.append({"type": "transcript", "text": text})
        return out

    def _transcribe(self, samples: np.ndarray) -> str:
        with _rec_lock:
            rec = _recognizer(self._lang)
            stream = rec.create_stream()
            stream.accept_waveform(SAMPLE_RATE, samples)
            rec.decode_stream(stream)
            return str(stream.result.text or "")


def status(lang: str) -> dict[str, Any]:
    """给设置页/探针用的状态。"""
    return {
        "engine": "sensevoice",
        "ready": ready(),
        "language": _LANG.get(lang, "auto"),
        "missing": missing_models(),
    }
