# Bundled speech resources

The offline installation includes **SenseVoice-Small int8**, its token table,
and **Silero VAD**. The application never downloads them. All files in
`manifest.json` are mandatory release inputs and are verified by size and SHA256.

- SenseVoice-Small model and token conversion: csukuangfj, sherpa-onnx export,
  https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17
  revision `2365baeacb507f821a0c8120fcee3d484dba7a07`.
  Original model: FunAudioLLM / Alibaba Group,
  https://huggingface.co/FunAudioLLM/SenseVoiceSmall,
  model-card revision `3847d57b6bdf2dd8875cb1508d2af43d80a16bf7`.
  Model weights use the **FunASR Model Open Source License Agreement 1.1**,
  included as `licenses/FunASR-MODEL-LICENSE`. The export's original license
  reference is retained as `licenses/ONNX-LICENSE-REFERENCE`.
  `licenses/SenseVoice-LICENSE` is the separately licensed MIT source-code
  notice from SenseVoice commit `586bbdb2b052f4fe19322581825228b6810a9fb3`;
  it does not replace the model license.
- Silero VAD model export: csukuangfj,
  https://huggingface.co/csukuangfj/vad,
  revision `fba88cd2e921609e7675c3aaf51e0b9b295da4bc`.
  Original model: Silero Team, https://github.com/snakers4/silero-vad,
  MIT notice from commit `1e261b036686cd0017d500ee96acd1c4ba572a9d`
  included as `licenses/Silero-VAD-LICENSE`.

Model names, authors and source references are retained in this distribution.
The model license is distinct from the runtime library licenses. Runtime wheel
redistribution notices belong to the future platform-specific installer build.

The FunASR model-license snapshot was retrieved on 2026-10-21 from commit
`24217c8ff0b81f3d967593f0bf84609306929f99`; its SHA256 and immutable source
URL are pinned in the manifest. The pinned model bytes are unchanged.
