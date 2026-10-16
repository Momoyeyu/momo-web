"""接口契约的漂移守卫：提交的 openapi.json 必须与代码一致。

它替代了原来手写的 docs/backend-api.md —— 手写文档会腐化，而且那份还在
.gitignore 里，协作者根本看不到。现在契约由代码生成、提交进仓库。
"""

from __future__ import annotations

import json

from scripts.export_openapi import OUT, render


def test_committed_openapi_json_matches_code():
    assert OUT.exists(), "缺少 openapi.json：跑 scripts/export_openapi.py"
    got = OUT.read_text(encoding="utf-8")
    assert got == render(), (
        "openapi.json 与代码不一致（接口改了却没重新导出）：\n"
        "  cd backend && .venv/bin/python scripts/export_openapi.py"
    )


def test_openapi_json_describes_every_route():
    """导出内容得真有料：每条路径都要有 2xx 响应，且 schema 非空。"""
    doc = json.loads(OUT.read_text(encoding="utf-8"))
    assert doc["paths"], "paths 为空"
    for path, ops in doc["paths"].items():
        for method, op in ops.items():
            assert any(c.startswith("2") for c in op["responses"]), f"{method} {path} 缺 2xx 响应"
    assert doc.get("components", {}).get("schemas"), "没有 schema，前端生成不出类型"
