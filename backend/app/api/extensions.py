"""拓展相关端点：POST /api/extensions/probe 单条 server 连通性探测。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from ..services import extend
from ..models import ProbeResult

router = APIRouter()


@router.post("/api/extensions/probe")
def probe_extension(ext: dict[str, Any] = Body(...)) -> ProbeResult:
    """对一条拓展记录做 connect + list_tools + close 探测。

    body = 单条拓展配置 JSON（来自设置页，未校验故按 dict 收）；返回形状见 models.ProbeResult。
    失败不抛错——不可达的 server 只是不可见，探测本身永不阻塞 UI。
    """
    return extend.probe(ext)


from fastapi import HTTPException
from ..services import plugins


@router.get("/api/extensions/plugins")
def list_plugins():
    return {"plugins": plugins.listing()}


@router.post("/api/extensions/plugins")
def install_plugin(bundle: dict[str, Any] = Body(...)):
    try:
        return plugins.install(bundle)
    except plugins.PluginRuntimeError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.patch("/api/extensions/plugins/{plugin_id}")
def toggle_plugin(plugin_id: str, payload: dict[str, Any] = Body(...)):
    if type(payload.get("enabled")) is not bool:
        raise HTTPException(400, "enabled must be boolean")
    if payload["enabled"] and payload.get("trustAccepted") is not True:
        raise HTTPException(400, "Explicit local-code trust acknowledgement required")
    try:
        return plugins.change(plugin_id, payload["enabled"])
    except plugins.PluginRuntimeError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.delete("/api/extensions/plugins/{plugin_id}")
def remove_plugin(plugin_id: str):
    try:
        return plugins.change(plugin_id, remove=True)
    except plugins.PluginRuntimeError as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
