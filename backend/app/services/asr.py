"""内置 ASR：SenseVoice-Small(int8) + silero VAD，全部在 backend 进程内跑。

设计要点：
- **不做流式解码**。SenseVoice 是非自回归整段模型，实时性靠 VAD 切句：
  音频进来先喂 VAD，检测到"说完一段"就把这段整段识别。对"用户说完一句
  → 模型开始回复"的 VN 对话节奏，这个粒度刚好够用。
- **语言**跟随设置里的对话语言（chatLang）：SenseVoice 支持
  auto/zh/en/ja/ko/yue，我们用 zh/en/ja（其余回落 auto）。
- **模型缺失不致命**：`ready()` 返回缺失清单，API 层据此回错误事件，
  前端自动提示"内置 ASR 不可用"。自定义 ASR 不受影响。
- 识别器按语言缓存：模型加载约 1s、常驻约 300MB，换语言时才重建。
"""
from __future__ import annotations

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
    or (Path(__file__).resolve().parents[2] / "models" / "asr")
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
    """修 sherpa-onnx macOS cp314 wheel 的已知打包缺陷。

    该 wheel 的 rpath 指向 `sherpa_onnx/lib/libonnxruntime.dylib`，但文件
    没打进去。装了 onnxruntime 时把它的 dylib 补到那个位置即可，只做一次。
    """
    try:
        import sherpa_onnx  # noqa: F401

        return
    except ImportError:
        pass
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        raise AsrError("sherpa-onnx 无法加载：缺少 onnxruntime") from None
    lib_dir = Path(__file__).resolve().parents[2] / ".venv"  # 仅开发环境兜底
    candidates = list(lib_dir.glob("lib/python*/site-packages/onnxruntime/capi/libonnxruntime*.dylib"))
    target_dir = next(
        iter(Path(os.environ.get("VIRTUAL_ENV", "")).glob("lib/python*/site-packages/sherpa_onnx/lib")),
        None,
    )
    if target_dir and candidates:
        target = target_dir / "libonnxruntime.dylib"
        if not target.exists():
            try:
                target.write_bytes(candidates[0].read_bytes())
            except OSError:
                pass
    import sherpa_onnx  # noqa: F401  （失败则抛 ImportError，由上层转 AsrError）


def missing_models() -> list[str]:
    """缺失的模型文件（相对路径）。空 = 齐备。"""
    need = {"sense-voice/model.int8.onnx": MODEL_PATH, "sense-voice/tokens.txt": TOKENS_PATH, "silero_vad.onnx": VAD_PATH}
    return [name for name, p in need.items() if not p.exists()]


def ready() -> bool:
    return not missing_models()


_recognizers: dict[str, Any] = {}
_rec_lock = threading.Lock()


def _recognizer(lang: str) -> Any:
    """按语言取（并缓存）识别器。加载失败抛 AsrError。"""
    code = _LANG.get(lang, "auto")
    with _rec_lock:
        rec = _recognizers.get(code)
        if rec is not None:
            return rec
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
        except Exception as e:  # noqa: BLE001 - 统一转领域错误
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
        self._lang = _LANG.get(lang, "auto")
        self._vad = _vad()
        self._speaking = False
        self._rec = _recognizer(self._lang)
        # int16 分帧残留（VAD 内部按 512 窗口处理，这里只需保证样本连续）
        self._carry = np.zeros(0, dtype=np.float32)

    # ---- 音频入口 ----

    def feed(self, pcm: bytes) -> list[dict[str, str]]:
        """喂一帧 s16le 16k mono，返回本帧产生的零到多个事件。"""
        if not pcm:
            return []
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        if self._carry.size:
            samples = np.concatenate([self._carry, samples])
            self._carry = np.zeros(0, dtype=np.float32)
        return self._consume(samples)

    def flush(self) -> list[dict[str, str]]:
        """收尾：把 VAD 里没吐完的尾段强制吐出来（用户松手/断连时调用）。"""
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
            stream = self._rec.create_stream()
            stream.accept_waveform(SAMPLE_RATE, samples)
            self._rec.decode_stream(stream)
            return str(stream.result.text or "")


def status(lang: str) -> dict[str, Any]:
    """给设置页/探针用的状态。"""
    return {
        "engine": "sensevoice",
        "ready": ready(),
        "language": _LANG.get(lang, "auto"),
        "missing": missing_models(),
    }
