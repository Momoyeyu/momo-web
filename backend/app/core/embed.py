"""Bundled multilingual E5 inference. This module never downloads resources.

CPU session and tokenizer are lazy, process-local, and serialized. E5 uses
query/passsage prefixes, masked mean pooling and L2 normalization (384 dims).
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import threading
from typing import Any

REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
MODEL_ID = f'Xenova/multilingual-e5-small@{REVISION}:int8:mean:l2:e5-prefix:v1:max512'
DIMENSION = 384
_lock = threading.Lock()
_session = None
_tokenizer = None
_loaded_path: Path | None = None
_error: str | None = None


def resource_dir() -> Path:
    root = Path(os.environ.get('MOMO_RESOURCES_DIR', str(Path(__file__).resolve().parents[2] / 'resources')))
    return root / 'embedding' / 'multilingual-e5-small'


def status() -> dict[str, Any]:
    """Cheap resource inspection; never imports ORT, hashes or loads the model."""
    root = resource_dir()
    missing = [name for name in ('model_quantized.onnx', 'tokenizer.json', 'manifest.json', 'LICENSE') if not (root / name).is_file()]
    loaded = _session is not None and _loaded_path == root
    return {'state': 'missing' if missing else ('error' if _error else ('loaded' if loaded else 'ready')),
            'model': MODEL_ID, 'dimension': DIMENSION, 'bundled': True,
            'missing': missing, 'error': _error}


def _load() -> None:
    global _session, _tokenizer, _loaded_path
    root = resource_dir()
    if _session is not None and _loaded_path == root:
        return
    manifest = json.loads((root / 'manifest.json').read_text())
    if manifest['model_identity'] != MODEL_ID:
        raise ValueError('Bundled embedding manifest has a different model identity')
    for entry in manifest['files']:
        path = root / entry['path']
        if path.stat().st_size != entry['size_bytes']:
            raise ValueError(f'Bundled embedding resource has invalid size: {path.name}')
        with path.open('rb') as f:
            digest = hashlib.file_digest(f, 'sha256').hexdigest()
        if digest != entry['sha256']:
            raise ValueError(f'Bundled embedding checksum failed: {path.name}')
    import onnxruntime as ort
    from tokenizers import Tokenizer
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    tokenizer = Tokenizer.from_file(str(root / 'tokenizer.json'))
    tokenizer.enable_truncation(max_length=512)
    tokenizer.enable_padding(pad_id=1, pad_token='<pad>')
    session = ort.InferenceSession(str(root / 'model_quantized.onnx'), sess_options=options,
                                   providers=['CPUExecutionProvider'])
    _session, _tokenizer, _loaded_path = session, tokenizer, root


def embed(text: str, cfg: dict[str, Any] | None = None) -> list[float] | None:
    """Return local vector; failed resource/inference leaves lexical recall usable.

    Legacy remote URL/key fields are deliberately ignored. `role=passage` is
    reserved for memory indexing; all ordinary calls encode a query.
    """
    global _error
    if not text or not text.strip():
        return None
    with _lock:
        try:
            _load()
            import numpy as np
            role = 'passage' if (cfg or {}).get('role') == 'passage' else 'query'
            encoded = _tokenizer.encode(f'{role}: {text}')
            values = {'input_ids': np.array([encoded.ids], dtype=np.int64),
                      'attention_mask': np.array([encoded.attention_mask], dtype=np.int64),
                      'token_type_ids': np.array([encoded.type_ids], dtype=np.int64)}
            feeds = {item.name: values[item.name] for item in _session.get_inputs()}
            tokens = _session.run(None, feeds)[0]
            mask = values['attention_mask'][..., None]
            pooled = (tokens * mask).sum(axis=1) / mask.sum(axis=1).clip(min=1)
            vector = pooled[0]
            norm = np.linalg.norm(vector)
            if not np.isfinite(vector).all() or norm <= 0 or len(vector) != DIMENSION:
                raise ValueError('Invalid local embedding output')
            _error = None
            return (vector / norm).astype(float).tolist()
        except Exception as exc:
            _error = f'{type(exc).__name__}: {exc}'
            return None
