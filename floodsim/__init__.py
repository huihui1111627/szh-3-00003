"""沿海城市潮汐防洪推演参考内核。

模块:
  model     水网拓扑与推演数据结构
  engine    时间步进求解器 / 增量执行 / 快照
  rules     倒灌、过载、上下游冲突诊断与替代组合
  scenario  多方案管理、同步比较
  session   断点续演(事件快照, JSON 落盘)
"""

from .model import (
    Block, City, Gate, Interlock, PumpStation, Rainfall, WaterBody,
)
from .engine import Controls, Engine, Snapshot
from .rules import analyze
from .scenario import Scenario, compare
from .session import SessionStore

__all__ = [
    "Block", "City", "Gate", "Interlock", "PumpStation", "Rainfall",
    "WaterBody", "Controls", "Engine", "Snapshot", "analyze",
    "Scenario", "compare", "SessionStore",
]
