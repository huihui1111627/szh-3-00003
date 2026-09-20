"""断点续演: 推演会话快照的 JSON 落盘与恢复。

前端/网关在每 N 步或调整调度时调用 save(); 意外断开后用 resume()
恢复到最后一步, 再继续 run() 即可, 未完成的推演不会丢失。
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict
from typing import Dict, List

from .engine import Controls, Engine, GateAction, PumpAction, Snapshot
from .scenario import Scenario


class SessionStore:
    VERSION = 1

    def __init__(self, path: str):
        self.path = path

    @staticmethod
    def _controls_to_dict(controls: Controls) -> dict:
        return {
            "gate_actions": [asdict(a) for a in controls.gate_actions],
            "pump_actions": [asdict(a) for a in controls.pump_actions],
            "diversion_order": list(controls.diversion_order),
            "forced_close": list(controls.forced_close),
        }

    @staticmethod
    def _controls_from_dict(data: dict) -> Controls:
        return Controls(
            gate_actions=[GateAction(**a) for a in data.get("gate_actions", [])],
            pump_actions=[PumpAction(**a) for a in data.get("pump_actions", [])],
            diversion_order=tuple(data.get("diversion_order", [])),
            forced_close=tuple(data.get("forced_close", [])),
        )

    @staticmethod
    def _snapshot_to_dict(snap: Snapshot) -> dict:
        return asdict(snap)

    @staticmethod
    def _snapshot_from_dict(data: dict) -> Snapshot:
        return Snapshot(
            k=data["k"], t=data["t"], levels=data["levels"],
            volumes=data["volumes"], depths=data["depths"],
            gate_open=data["gate_open"], events=data["events"],
            arrival=data["arrival"], history=data.get("history", []))

    def save(self, session_id: str, city: City, scenarios: Dict[str, Scenario]) -> None:
        if os.path.exists(self.path):
            with open(self.path, "r", encoding="utf-8") as f:
                store = json.load(f)
        else:
            store = {}
        store[session_id] = {
            "dt": city.dt, "horizon": city.horizon,
            "scenarios": {
                sid: {
                    "name": sc.name,
                    "controls": self._controls_to_dict(sc.controls),
                    "snapshot": self._snapshot_to_dict(sc.snapshot())
                    if sc.engine is not None else None,
                }
                for sid, sc in scenarios.items()},
        }
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(self.path) or ".", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(store, f, ensure_ascii=False)
        os.replace(tmp, self.path)

    def resume(self, session_id: str, city_factory) -> Dict[str, Scenario]:
        """city_factory: () -> City, 从静态水网配置重建拓扑。"""
        with open(self.path, "r", encoding="utf-8") as f:
            store = json.load(f)
        saved = store[session_id]
        out: Dict[str, Scenario] = {}
        for sid, data in saved["scenarios"].items():
            city = city_factory()
            controls = self._controls_from_dict(data["controls"])
            engine = Engine(city, controls,
                            snapshot=self._snapshot_from_dict(data["snapshot"]))
            if engine.t < city.horizon - 1e-9:
                engine.run()
            sc = Scenario(id=sid, name=data["name"], controls=controls,
                          city=city, engine=engine)
            out[sid] = sc
        return out

    def sessions(self) -> List[str]:
        if not os.path.exists(self.path):
            return []
        with open(self.path, "r", encoding="utf-8") as f:
            return list(json.load(f).keys())
