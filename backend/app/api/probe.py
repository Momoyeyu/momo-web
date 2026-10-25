"""Provider probes keep credentials out of browser networking and diagnostic output."""
import time
from urllib.parse import urlsplit, urlunsplit
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..core.llm import LlmError, _thinking_payload

router = APIRouter()
class Probe(BaseModel):
    url: str
    key: str = ""
    model: str = ""
    thinking: bool = False

@router.post('/api/probe/llm')
async def llm_probe(cfg: Probe):
    try:
        parsed = urlsplit(cfg.url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.query:
            raise ValueError()
        parsed.port
    except ValueError:
        raise HTTPException(400, 'Invalid provider URL')
    path = parsed.path.rstrip('/')
    if path.endswith('/chat/completions'):
        path = path[:-len('/chat/completions')]
    if not path.endswith('/v1'):
        path += '/v1'
    url = urlunsplit((parsed.scheme, parsed.netloc, path + '/models', '', ''))
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=20 if cfg.model else 5, follow_redirects=False, trust_env=False) as client:
            headers = {'Authorization': f'Bearer {cfg.key}'} if cfg.key else {}
            if cfg.model:
                # Exercise the same URL and model identifier as a real dialogue;
                # /models alone can succeed while completions reject the model.
                payload = {'model': cfg.model, 'messages': [{'role': 'user', 'content': 'Reply only OK.'}],
                           'stream': False}
                _thinking_payload(cfg.model_dump(), payload)
                response = await client.post(cfg.url.rstrip('/') + '/v1/chat/completions', json=payload, headers=headers)
            else:
                response = await client.get(url, headers=headers)
        ok = response.is_success or (not cfg.model and response.status_code == 405)
        if ok and cfg.model:
            try:
                message = response.json()['choices'][0]['message']
                if not isinstance(message, dict):
                    raise ValueError()
            except (ValueError, KeyError, IndexError, TypeError):
                return {'ok': False, 'detail': 'invalid response'}
        return {'ok': ok, 'detail': f'{round((time.monotonic()-started)*1000)}ms' if ok else f'HTTP {response.status_code}'}
    except LlmError:
        return {'ok': False, 'detail': 'thinking unsupported'}
    except httpx.TimeoutException:
        return {'ok': False, 'detail': 'timeout'}
    except httpx.HTTPError:
        return {'ok': False, 'detail': 'unreachable'}
