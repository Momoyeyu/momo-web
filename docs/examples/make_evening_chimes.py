"""Build the original Evening Chimes BGM example using only Python's standard library."""
import hashlib
import io
import json
import math
from pathlib import Path
import struct
import wave
import zipfile

RATE = 16000
# A six-second phrase. Bell overtones decay independently and the final rest
# leaves both ends of the loop silent.
NOTES = [(0, 62), (0.75, 69), (1.50, 66), (2.25, 64), (3.0, 59), (4.0, 62)]


def compose():
    samples = [0.0] * (6 * RATE)
    for start, midi in NOTES:
        frequency = 440 * 2 ** ((midi - 69) / 12)
        index = round(start * RATE)
        for n in range(round(1.65 * RATE)):
            t = n / RATE
            phase = math.tau * frequency * t
            fade = min(1.0, t / 0.012, (1.65 - t) / 0.06)
            samples[index + n] += fade * (
                math.sin(phase) * math.exp(-3 * t)
                + 0.22 * math.sin(2.01 * phase) * math.exp(-6 * t)
            )
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setparams((1, 2, RATE, len(samples), "NONE", "uncompressed"))
        wav.writeframes(b"".join(struct.pack("<h", round(8000 * value)) for value in samples))
    return out.getvalue()


def build():
    audio = compose()
    resource = "audio/evening-chimes.wav"
    manifest = {"formatVersion": 1, "kind": "content", "id": "example.evening-chimes",
                "name": "Evening Chimes", "version": "1.0.0", "momoApi": "^1.0.0",
                "platforms": ["*"], "files": {resource: hashlib.sha256(audio).hexdigest()},
                "resources": [{"type": "bgm", "path": resource}]}
    target = Path(__file__).with_name("evening-chimes.momomod")
    with zipfile.ZipFile(target, "w") as bundle:
        for path, data in [("manifest.json", json.dumps(manifest, indent=2).encode()), (resource, audio)]:
            info = zipfile.ZipInfo(path, (2026, 1, 1, 0, 0, 0))
            bundle.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
    return target


if __name__ == "__main__":
    print(build())
