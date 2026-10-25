"""Built-in resource status without loading models or starting inference."""
from ..core import embed
from . import asr, memory
from .prompt import conversation_lang
from ..core.state import load


def status() -> dict:
    return {'asr': asr.status(conversation_lang(load())),
            'embedding': embed.status(), 'index': memory.index_status()}
