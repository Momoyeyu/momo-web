"""agent 包：ReAct 循环 + 工具 + prompt 组装（对 api/ 暴露 run_turn）。"""
from .prompts import build_system_prompt
from .react import split_segments, run_turn
from .tools import TOOLS

__all__ = ["TOOLS", "build_system_prompt", "run_turn", "split_segments"]
