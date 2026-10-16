"""分层依赖方向的机械检查。

MVC 四层的价值全在「依赖单向」——一旦允许逆向 import，分层就只是目录名。
这个测试把方向约束变成可执行的东西：

    api → services → models → core

规则是白名单：某层只允许 import 它下面的层。新增跨层依赖时，
要么走正确的中间层，要么显式改这张表并说明理由。

注意 core 是叶子层：它只会为类型注解需要上层形状，而注解在
`from __future__ import annotations` 下不求值——故用 TYPE_CHECKING 引入，
运行时依赖为空。
"""

from __future__ import annotations

import ast
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"

#: 每层允许依赖的下层（同层/自身不算）。
ALLOWED: dict[str, set[str]] = {
    "core": set(),  # 支撑层：配置 / DB / 外部服务 / 工具
    "models": {"core"},  # M：数据形状 + 数据访问
    "services": {"core", "models"},  # 业务逻辑
    "api": {"models", "services"},  # C：HTTP / SSE 端点
    # app/ 根的 main.py 是组装点，可以引用任何层
    "": {"api", "core", "models", "services"},
}

#: 顶层模块名也算一层（models 是包，但保留此集合以便将来放单文件层）。
LAYERS = set(ALLOWED) - {""}


def _layer_of(path: Path) -> str:
    parts = path.relative_to(APP).parts
    if len(parts) == 1:
        return path.stem if path.stem in LAYERS else ""
    return parts[0] if parts[0] in LAYERS else ""


def _is_type_checking(test: ast.expr) -> bool:
    return isinstance(test, ast.Name) and test.id == "TYPE_CHECKING"


def _runtime_imports(tree: ast.Module) -> list[ast.ImportFrom]:
    """模块里**运行时**生效的相对导入。

    `if TYPE_CHECKING:` 分支整块跳过——那些 import 只服务类型注解，
    在 `from __future__ import annotations` 下不求值，不构成运行时依赖。
    """
    found: list[ast.ImportFrom] = []
    stack: list[ast.AST] = list(tree.body)
    while stack:
        node = stack.pop()
        if isinstance(node, ast.If) and _is_type_checking(node.test):
            continue  # 整块剪掉
        if isinstance(node, ast.ImportFrom):
            found.append(node)
        stack.extend(ast.iter_child_nodes(node))
    return found


def _relative_deps(path: Path) -> list[tuple[int, str]]:
    """该文件所有运行时相对导入落到的顶层层名。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    inside_layer = path.parent != APP and path.parent.name in LAYERS
    base = [path.parent.name] if inside_layer else []
    out: list[tuple[int, str]] = []
    for node in _runtime_imports(tree):
        if node.level == 0:
            continue
        up = node.level - 1
        target = (base[: len(base) - up] if up else base) + (
            [node.module] if node.module else []
        )
        if target:
            out.append((node.lineno, target[0]))
    return out


def test_layers_only_depend_downwards():
    violations: list[str] = []
    for path in sorted(APP.rglob("*.py")):
        me = _layer_of(path)
        for lineno, dep in _relative_deps(path):
            if dep == me or dep not in ALLOWED:
                continue
            if dep not in ALLOWED[me]:
                rel = path.relative_to(APP.parent)
                violations.append(f"{rel}:{lineno}  {me or 'root'} → {dep}")
    assert not violations, "分层依赖方向违规：\n  " + "\n  ".join(violations)
