"""agent 包：ReAct 循环 + 能力 + prompt 组装（对 api/ 暴露 run_turn）。"""
from .prompt import build_system_prompt
from .loop import split_segments, run_turn
from .capability import TOOLS

__all__ = ["TOOLS", "build_system_prompt", "run_turn", "split_segments"]
