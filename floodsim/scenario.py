"""多方案推演与同步回放比较。"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Dict, List, Optional

from .engine import Controls, Engine, Snapshot
from .model import City
from .rules import Analysis, analyze


@dataclass
class Scenario:
    id: str
    name: str
    controls: Controls
    city: Optional[City] = None
    engine: Optional[Engine] = None
    analysis: Optional[Analysis] = None

    def start(self, template: City, run_now: bool = True) -> "Scenario":
        self.city = copy.deepcopy(template)
        self.engine = Engine(self.city, copy.deepcopy(self.controls))
        if run_now:
            self.engine.run()
        return self

    def analyze_controls(self, template: City) -> Analysis:
        """以当前 Controls 重新预测(诊断+替代组合), 不影响主画布。"""
        self.analysis = analyze(template, self.controls)
        return self.analysis

    def apply_controls(self, controls: Controls, template: City) -> None:
        """用户改闸/泵站/分洪顺序后: 用新组合整程重算该方案。"""
        self.controls = copy.deepcopy(controls)
        self.start(template)

    def frame(self, t: float) -> dict:
        """取 t 时刻的同步回放帧(水位/水深/闸/泵)。"""
        assert self.engine is not None, "方案尚未启动"
        recs = self.engine.results.records
        rec = min(recs, key=lambda r: abs(r.t - t))
        return {
            "scenario": self.id, "t": rec.t, "levels": dict(rec.levels),
            "depths": dict(rec.depths), "gate_open": dict(rec.gate_open),
            "gate_flow": dict(rec.gate_flow),
            "pump_flow": dict(rec.pump_flow), "pump_load": dict(rec.pump_load),
            "interlock_closed": dict(rec.interlock_closed),
        }

    def snapshot(self) -> Snapshot:
        assert self.engine is not None, "方案尚未启动"
        return self.engine.snapshot()


def compare(scenarios: List[Scenario], times: Optional[List[float]] = None) -> dict:
    """生成同步回放比较: 统一时间轴 + 各方案关键指标。"""
    if times is None:
        horizon = min(s.city.horizon for s in scenarios if s.city)
        dt = min(s.city.dt for s in scenarios if s.city)
        times = [float(k * dt) for k in range(int(horizon / dt) + 1)]
    frames = [[s.frame(t) for s in scenarios] for t in times]
    metrics = {}
    for s in scenarios:
        arr = s.engine.results.arrival
        metrics[s.id] = {
            "name": s.name,
            "peak_depth": {bid: v["peak"] for bid, v in arr.items()},
            "arrival": {bid: v["arrival"] for bid, v in arr.items()},
            "max_load": max((max(r.pump_load.values(), default=0.0)
                             for r in s.engine.results.records), default=0.0),
            "backflow_events": sum(
                1 for e in s.engine.results.events if e["type"] == "backflow"),
        }
    return {"times": times, "frames": frames, "metrics": metrics}


def export_timeline(scenario: Scenario) -> dict:
    """导出单方案完整时间轴(供前端地图积水面、水位/负荷曲线渲染)。"""
    eng = scenario.engine
    recs = eng.results.records
    return {
        "scenario": scenario.id,
        "name": scenario.name,
        "dt": scenario.city.dt,
        "horizon": scenario.city.horizon,
        "times": [r.t for r in recs],
        "series": {
            "levels": [r.levels for r in recs],
            "depths": [r.depths for r in recs],
            "gate_open": [r.gate_open for r in recs],
            "gate_flow": [r.gate_flow for r in recs],
            "pump_flow": [r.pump_flow for r in recs],
            "pump_load": [r.pump_load for r in recs],
            "interlock_alarm": [r.interlock_closed for r in recs],
        },
        "events": eng.results.events,
        "arrival": eng.results.arrival,
    }
