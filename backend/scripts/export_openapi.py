"""把 FastAPI 的 OpenAPI schema 导出到 backend/openapi.json。

这份 JSON 是**接口契约的唯一事实源**（提交进仓库，协作者可见）：
- 人看：启服务后 /docs（Swagger UI）与 /redoc
- 机器用：frontend 的 `pnpm gen:api` 据此生成 TS 类型

改了接口就重新导出一次：

    cd backend && .venv/bin/python scripts/export_openapi.py

tests/test_openapi.py 会检查提交的文件与代码一致，漂移即失败。
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "openapi.json"


def render() -> str:
    """稳定序列化：键排序 + 2 空格缩进 —— 同一份代码必须导出逐字相同的结果。"""
    return json.dumps(app.openapi(), indent=2, ensure_ascii=False, sort_keys=True) + "\n"


if __name__ == "__main__":
    OUT.write_text(render(), encoding="utf-8")
    print(f"导出完成：{OUT}")
