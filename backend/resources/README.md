# Installation resources (build contract)

Every installation ships both `asr/` and `embedding/multilingual-e5-small/`.
There is no first-launch download, optional player resource pack, model picker,
or runtime network fallback. Large binaries are ignored by Git; pinned manifests,
licenses, provenance and preparation scripts remain versioned.

For source builds, from `backend/`:

```sh
uv sync --group dev
uv run python scripts/download_asr_models.py
uv run python scripts/prepare_embedding.py
uv run python scripts/package_resources.py --verify
uv run python scripts/package_resources.py --output ../dist/momo-resources.zip
uv run python scripts/package_resources.py --verify-archive ../dist/momo-resources.zip
```

Preparation is a developer/release operation. It uses pinned source revisions and
SHA256 checks, writes downloads atomically and refuses invalid existing assets.
Packaging is offline and fails if either ASR or embedding files or notices are
missing/corrupt. The archive includes per-component manifests and one complete
`resource-manifest.json`; archive verification checks both. File order, timestamps
and permissions are fixed for repeatable builds with the same Python/zlib runtime.

The installer must unpack this archive into a read-only resource directory during
initial installation, then set `MOMO_RESOURCES_DIR` to that directory before
starting the backend. Both services share this override. Its structure is:

```
<resources>/
  resource-manifest.json
  asr/manifest.json
  asr/sense-voice/{model.int8.onnx,tokens.txt}
  asr/silero_vad.onnx
  asr/licenses/...
  asr/PROVENANCE.md
  embedding/multilingual-e5-small/{model_quantized.onnx,tokenizer.json,manifest.json,LICENSE,UPSTREAM_README.md}
```

To validate an extracted installation resource tree:

```sh
uv run python scripts/package_resources.py --verify --resources-dir /path/to/resources
```

Development defaults remain `backend/models/asr/` for ASR binaries and
`backend/resources/embedding/multilingual-e5-small/` for embedding. ASR's old
`MOMO_ASR_MODELS` developer override takes precedence over the common resource
root. These paths contain immutable application resources, separate from user
settings, databases and voice recordings.

The ZIP is platform-neutral installer input, not a native desktop installer.
Native macOS/Windows/Linux installers and their ONNX library smoke tests belong
to the desktop packaging work. No untested platform support is implied here.
