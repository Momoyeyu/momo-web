"""下载内置 ASR 模型：SenseVoice-Small int8 + silero VAD。

用法（backend 目录下）：
    uv run python scripts/download_asr_models.py          # 缺什么下什么
    uv run python scripts/download_asr_models.py --force  # 强制重下

落盘位置：backend/models/asr/
    sense-voice/{model.int8.onnx, tokens.txt}
    silero_vad.onnx

源地址按顺序 fallback：国内 HF 镜像（默认）→ HuggingFace 官方 → GitHub release。
可用 MOMO_MODEL_MIRROR 覆盖镜像前缀（例如内网代理）。
"""
from __future__ import annotations

import argparse
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models" / "asr"

MIRROR = os.environ.get("MOMO_MODEL_MIRROR", "https://hf-mirror.com").rstrip("/")
HF = "https://huggingface.co"
SENSE_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
VAD_REPO = "csukuangfj/vad"

# 每项：目标相对路径 → 依次尝试的来源
PLAN: list[tuple[str, list[str]]] = [
    (
        "sense-voice/model.int8.onnx",
        [
            f"{MIRROR}/{SENSE_REPO}/resolve/main/model.int8.onnx",
            f"{HF}/{SENSE_REPO}/resolve/main/model.int8.onnx",
        ],
    ),
    (
        "sense-voice/tokens.txt",
        [
            f"{MIRROR}/{SENSE_REPO}/resolve/main/tokens.txt",
            f"{HF}/{SENSE_REPO}/resolve/main/tokens.txt",
        ],
    ),
    (
        "silero_vad.onnx",
        [
            f"{MIRROR}/{VAD_REPO}/resolve/main/silero_vad.onnx",
            f"{HF}/{VAD_REPO}/resolve/main/silero_vad.onnx",
        ],
    ),
]


def _download(url: str, dest: Path) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": "momo-web/0.1 (+sherpa-onnx model fetch)"}
        )
        with urllib.request.urlopen(req, timeout=60) as resp, tmp.open("wb") as f:
            total = int(resp.headers.get("content-length") or 0)
            done = 0
            while chunk := resp.read(1 << 20):
                f.write(chunk)
                done += len(chunk)
                if total:
                    pct = done * 100 // total
                    print(f"\r  {pct:3d}%  {done / 1e6:.1f}/{total / 1e6:.1f} MB", end="")
            print()
        tmp.replace(dest)
        return True
    except Exception as e:  # noqa: BLE001 - 网络错误统一换下一个源
        tmp.unlink(missing_ok=True)
        print(f"  ✗ {url.split('/')[2]}: {e}")
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="已存在也重新下载")
    args = ap.parse_args()

    MODELS.mkdir(parents=True, exist_ok=True)
    failed = False
    for rel, sources in PLAN:
        dest = MODELS / rel
        if dest.exists() and not args.force and dest.stat().st_size > 1024:
            print(f"✓ {rel}（{dest.stat().st_size / 1e6:.1f} MB）")
            continue
        ok = False
        for url in sources:
            print(f"↓ {rel}  ←  {url.split('/')[2]}")
            if _download(url, dest):
                ok = True
                break
        if not ok:
            print(f"✗ {rel} 下载失败（所有源不可达）")
            failed = True

    if failed:
        print("部分模型缺失：内置 ASR 不可用（切换到自定义 ASR 不受影响）")
        return 1
    print(f"完成：{MODELS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
