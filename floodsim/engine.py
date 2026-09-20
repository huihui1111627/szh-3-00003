"""时间步进求解器。

每步(显式):
  1. 外海潮位、上游来水、降雨边界;
  2. 执行调度指令(闸开度/泵站组合), 挡潮联锁与分洪顺序自动约束;
  3. 计算各连接流量(宽顶堰/淹没流/倒流, 泵站定流量抽水);
  4. 节点质量平衡, 水量不足时按比例缩减出流, 更新水位与积水深。

引擎支持逐步执行(供"改一处、重新预测")、快照/恢复(断点续演)。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .model import City, Gate, G


@dataclass
class GateAction:
    gate_id: str
    opening: float  # 0..1
    time: float


@dataclass
class PumpAction:
    station_id: str
    on_units: int
    mobile_on: float
    time: float


@dataclass
class Controls:
    """一次推演的全部人工调度。

    gate_actions/pump_actions 为带时间戳的绝对设定;
    diversion_order 为分洪闸开启的优先级顺序;
    forced_close_gate 可模拟硬联锁(人工强制挡潮闸常闭)。
    """

    gate_actions: List[GateAction] = field(default_factory=list)
    pump_actions: List[PumpAction] = field(default_factory=list)
    diversion_order: Tuple[str, ...] = ()
    forced_close: Tuple[str, ...] = ()


@dataclass
class StepRecord:
    k: int
    t: float
    levels: Dict[str, float] = field(default_factory=dict)
    depths: Dict[str, float] = field(default_factory=dict)
    gate_open: Dict[str, float] = field(default_factory=dict)
    gate_flow: Dict[str, float] = field(default_factory=dict)
    pump_flow: Dict[str, float] = field(default_factory=dict)
    pump_load: Dict[str, float] = field(default_factory=dict)
    interlock_closed: Dict[str, bool] = field(default_factory=dict)


@dataclass
class Results:
    records: List[StepRecord] = field(default_factory=list)
    events: List[dict] = field(default_factory=list)
    arrival: Dict[str, dict] = field(default_factory=dict)


def weir_flow(gate: Gate, h_up: float, h_down: float) -> float:
    """闸孔/宽顶堰流量, 带符号(src->dst 为正; 负值=倒灌)。

    block 类拍门仅允许正向(街区->河道), 反向顶托时归零。
    """
    opening = max(0.0, min(1.0, gate.opening))
    if opening <= 0.0:
        return 0.0

    def one_way(h_high: float, h_low: float) -> float:
        head = h_high - gate.crest
        if head <= 0.0:
            return 0.0
        free = gate.cw * gate.width * math.sqrt(G) * head ** 1.5
        sub = h_low - gate.crest
        if sub <= 0.0:
            return opening * free
        ratio = min(sub / head, 1.0)
        return opening * free * max(0.0, 1.0 - ratio ** 1.5) ** 0.385

    if h_up >= h_down:
        return one_way(h_up, h_down)
    if gate.kind == "block":
        return 0.0
    return -one_way(h_down, h_up)


@dataclass
class Snapshot:
    """断点续演快照: 当前步 + 全域状态 + 已发生事件。"""

    k: int
    t: float
    levels: Dict[str, float]
    volumes: Dict[str, float]
    depths: Dict[str, float]
    gate_open: Dict[str, float]
    events: List[dict]
    arrival: Dict[str, dict]
    history: List[dict] = field(default_factory=list)


class Engine:
    DEEP_WARNING = 0.15  # m, 达到即视为"开始积水"

    def __init__(self, city: City, controls: Optional[Controls] = None,
                 snapshot: Optional[Snapshot] = None):
        self.city = city
        self.controls = controls or Controls()
        self.results = Results()
        if snapshot is None:
            city.reset()
            self.k = 0
            self.t = 0.0
            self._active_overloads: Dict[str, bool] = {}
            self._active_backflow: Dict[str, bool] = {}
            self._record()
        else:
            city.reset()
            self.k = snapshot.k
            self.t = snapshot.t
            self._active_overloads = {}
            self._active_backflow = {}
            self._restore(snapshot)
            self.results.events = list(snapshot.events)
            self.results.arrival = dict(snapshot.arrival)

    # ---------- 水位访问 ----------
    def _node_level(self, node_id: str) -> float:
        if node_id in self.city.bodies:
            body = self.city.bodies[node_id]
            return body.tide_level(self.t) if body.is_sea else body.level
        return self.city.blocks[node_id].water_level

    # ---------- 调度 ----------
    def _apply_controls(self):
        city = self.city
        closed = {}
        alarm = {}
        # 人工闸控(tide/plain/block 都可调; 挡潮闸可能被联锁覆盖)
        latest_gate: Dict[str, GateAction] = {}
        for a in self.controls.gate_actions:
            if a.time <= self.t + 1e-9:
                old = latest_gate.get(a.gate_id)
                if old is None or a.time >= old.time:
                    latest_gate[a.gate_id] = a
        for gid, a in latest_gate.items():
            gate = city.gates.get(gid)
            if gate is not None and gate.kind != "diversion":
                gate.opening = a.opening
        # 泵站组合
        latest_pump: Dict[str, PumpAction] = {}
        for a in self.controls.pump_actions:
            if a.time <= self.t + 1e-9:
                old = latest_pump.get(a.station_id)
                if old is None or a.time >= old.time:
                    latest_pump[a.station_id] = a
        for sid, a in latest_pump.items():
            st = city.stations.get(sid)
            if st:
                st.on_units = max(0, min(st.unit_count, a.on_units))
                st.mobile_on = max(0.0, min(st.mobile_capacity, a.mobile_on))
        # 挡潮联锁: 超阈值产生告警; 仅人工预案 forced_close 物理关闭
        forced = set(self.controls.forced_close)
        for lk in city.interlocks:
            gate = city.gates[lk.gate_id]
            sea = city.bodies[gate.dst] if city.bodies[gate.dst].is_sea else city.bodies[gate.src]
            sea_level = sea.tide_level(self.t)
            alarm[gate.id] = sea_level >= lk.trigger_level
            closed[gate.id] = gate.id in forced
            if gate.id in forced:
                gate.opening = 0.0
        # 分洪顺序: 上一级已开启且水位够, 才自动开下一级
        order = self.controls.diversion_order
        diversion = {g.id: g for g in city.diversion_gates()}
        prev_open = True
        for gid in order:
            gate = diversion.get(gid)
            if gate is None:
                prev_open = False
                continue
            if not prev_open:
                gate.opening = 0.0
                continue
            h_up = self._node_level(gate.src)
            # 轮到该闸: 上游水位超过堰顶即自动开启, 之后保持开启
            if gate.opening > 0.0 or h_up >= gate.crest:
                gate.opening = 1.0
            prev_open = gate.opening > 0.0
        # 未纳入顺序的分洪闸保持关闭
        for gid, gate in diversion.items():
            if gid not in order:
                gate.opening = 0.0
        return closed, alarm

    # ---------- 一步水动力 ----------
    def _step_flows(self, closed: Dict[str, bool]):
        city = self.city
        flows: Dict[str, float] = {}
        for gate in city.gates.values():
            if closed.get(gate.id):
                flows[gate.id] = 0.0
                continue
            flows[gate.id] = weir_flow(
                gate, self._node_level(gate.src), self._node_level(gate.dst))

        pump_flow: Dict[str, float] = {}
        pump_load: Dict[str, float] = {}
        for st in city.stations.values():
            rated = st.unit_capacity * st.on_units
            total = rated + st.mobile_on
            delivered = total
            src = city.bodies.get(st.src) or city.blocks.get(st.src)
            available = src.depth * src.area if st.src in city.blocks else src.volume
            if total * city.dt > available:
                delivered = max(0.0, available / city.dt)
            delivered = min(delivered, total)
            pump_flow[st.id] = delivered
            capacity = rated + st.mobile_capacity
            pump_load[st.id] = (delivered / capacity) if capacity > 0 else (1.0 if delivered > 0 else 0.0)
            if rated > 0 and total > rated and total / rated >= st.overload_threshold + 1e-9:
                self._overload_event(st, total, rated)
        return flows, pump_flow, pump_load

    def _overload_event(self, st, total, rated):
        active = self._active_overloads.get(st.id)
        if active:
            return
        self._active_overloads[st.id] = True
        self.results.events.append({
            "type": "overload", "time": self.t, "station": st.id,
            "load": total / rated,
            "message": f"泵站 {st.name} 移动泵车叠加后负荷 {total / rated:.0%}, "
                       f"超过额定 {rated:.1f} m3/s, 存在过载跳机风险",
        })

    def _balance(self, flows, pump_flow, closed, alarm):
        city = self.city
        net = {bid: 0.0 for bid in city.bodies if not city.bodies[bid].is_sea}
        bnet = {blk.id: 0.0 for blk in city.blocks.values()}

        for gate in city.gates.values():
            q = flows[gate.id]
            if gate.src in net:
                net[gate.src] -= q
            if gate.src in bnet:
                bnet[gate.src] -= q
            if gate.dst in net:
                net[gate.dst] += q
            if gate.dst in bnet:
                bnet[gate.dst] += q
            if q < -1e-9 and gate.kind == "tide" and alarm.get(gate.id):
                self._backflow_event(gate, q)
            elif q >= -1e-9:
                self._active_backflow[gate.id] = False
        for st in city.stations.values():
            q = pump_flow[st.id]
            if st.src in net:
                net[st.src] -= q
            if st.src in bnet:
                bnet[st.src] -= q
            if st.dst in net:
                net[st.dst] += q

        # 降雨与上游来水
        for blk in city.blocks.values():
            intensity = city.rainfall.intensity(self.t, blk.id)  # mm/h
            bnet[blk.id] += intensity / 1000.0 / 3600.0 * blk.area
        for body in city.bodies.values():
            if not body.is_sea:
                net[body.id] += body.inflow_at(self.t)

        # 水量不足 -> 迭代缩减各节点出流, 再重新汇网, 保证质量守恒
        dt = city.dt
        for _ in range(4):
            for bid, dq in net.items():
                body = city.bodies[bid]
                min_vol = body.stage_volume[0][1]
                if body.volume + dq * dt >= min_vol - 1e-9:
                    continue
                out_cap = max(0.0, (body.volume - min_vol) / dt)
                outgoing = []
                for gate in city.gates.values():
                    if gate.src == bid and flows[gate.id] > 0:
                        outgoing.append(("gate", gate.id, flows[gate.id]))
                for st in city.stations.values():
                    if st.src == bid and pump_flow[st.id] > 0:
                        outgoing.append(("pump", st.id, pump_flow[st.id]))
                out_total = sum(x[2] for x in outgoing)
                if out_total <= out_cap:
                    continue
                factor = 0.0 if out_total <= 0 else out_cap / out_total
                for kind, xid, _ in outgoing:
                    if kind == "gate":
                        flows[xid] *= factor
                    else:
                        pump_flow[xid] *= factor
            # 重新汇网
            net = {bid: 0.0 for bid in net}
            bnet = {bid: 0.0 for bid in bnet}
            for gate in city.gates.values():
                q = flows[gate.id]
                if gate.src in net:
                    net[gate.src] -= q
                if gate.src in bnet:
                    bnet[gate.src] -= q
                if gate.dst in net:
                    net[gate.dst] += q
                if gate.dst in bnet:
                    bnet[gate.dst] += q
            for st in city.stations.values():
                q = pump_flow[st.id]
                if st.src in net:
                    net[st.src] -= q
                if st.src in bnet:
                    bnet[st.src] -= q
                if st.dst in net:
                    net[st.dst] += q
            for blk in city.blocks.values():
                intensity = city.rainfall.intensity(self.t, blk.id)
                bnet[blk.id] += intensity / 1000.0 / 3600.0 * blk.area
            for body in city.bodies.values():
                if not body.is_sea:
                    net[body.id] += body.inflow_at(self.t)

        for blk in city.blocks.values():
            blk.depth = max(0.0, blk.depth + bnet[blk.id] * dt / blk.area)
        for bid, body in city.bodies.items():
            if not body.is_sea:
                body.volume = max(body.stage_volume[0][1], body.volume + net[bid] * dt)
                body.level = body.level_of(body.volume)

    def _backflow_event(self, gate: Gate, q: float):
        if self._active_backflow.get(gate.id):
            return
        self._active_backflow[gate.id] = True
        h_down = self._node_level(gate.dst)
        self.results.events.append({
            "type": "backflow", "time": self.t, "gate": gate.id, "flow": q,
            "message": f"闸门 {gate.name} 发生倒灌 {abs(q):.1f} m3/s: "
                       f"下游水位 {h_down:.2f} m 高于上游且闸门未关闭",
        })

    def _update_arrival(self):
        for blk in self.city.blocks.values():
            info = self.results.arrival.setdefault(
                blk.id, {"arrival": None, "peak_time": None, "peak": 0.0})
            if blk.depth >= self.DEEP_WARNING and info["arrival"] is None:
                info["arrival"] = self.t
            if blk.depth > info["peak"]:
                info["peak"] = blk.depth
                info["peak_time"] = self.t

    def _record(self):
        c = self.city
        rec = StepRecord(k=self.k, t=self.t)
        rec.levels = {bid: (b.tide_level(self.t) if b.is_sea else b.level)
                      for bid, b in c.bodies.items()}
        rec.depths = {bid: b.depth for bid, b in c.blocks.items()}
        rec.gate_open = {gid: g.opening for gid, g in c.gates.items()}
        rec.gate_flow = {}
        rec.pump_flow = {}
        rec.pump_load = {}
        rec.interlock_closed = {}
        self.results.records.append(rec)

    def step(self, flows=None, pump_flow=None, pump_load=None, closed=None) -> StepRecord:
        closed, alarm = self._apply_controls()
        flows, pump_flow, pump_load = self._step_flows(closed)
        self._balance(flows, pump_flow, closed, alarm)
        self.k += 1
        self.t = self.k * self.city.dt
        self._update_arrival()
        self._record()
        rec = self.results.records[-1]
        rec.gate_flow = dict(flows)
        rec.pump_flow = dict(pump_flow)
        rec.pump_load = dict(pump_load)
        rec.interlock_closed = dict(alarm)
        return rec

    def run(self) -> Results:
        while self.t < self.city.horizon - 1e-9:
            self.step()
        return self.results

    # ---------- 快照 ----------
    def snapshot(self) -> Snapshot:
        c = self.city
        history = [{
            "k": r.k, "t": r.t, "levels": dict(r.levels),
            "depths": dict(r.depths), "gate_open": dict(r.gate_open),
            "gate_flow": dict(r.gate_flow), "pump_flow": dict(r.pump_flow),
            "pump_load": dict(r.pump_load),
            "interlock_closed": dict(r.interlock_closed),
        } for r in self.results.records]
        return Snapshot(
            k=self.k, t=self.t,
            levels={bid: b.level for bid, b in c.bodies.items()},
            volumes={bid: b.volume for bid, b in c.bodies.items()},
            depths={bid: b.depth for bid, b in c.blocks.items()},
            gate_open={gid: g.opening for gid, g in c.gates.items()},
            events=[dict(e) for e in self.results.events],
            arrival={k: dict(v) for k, v in self.results.arrival.items()},
            history=history,
        )

    def _restore(self, snap: Snapshot) -> None:
        c = self.city
        for bid, body in c.bodies.items():
            body.level = snap.levels[bid]
            body.volume = snap.volumes[bid]
        for bid, blk in c.blocks.items():
            blk.depth = snap.depths[bid]
        for gid, gate in c.gates.items():
            gate.opening = snap.gate_open.get(gid, 0.0)
        self.results = Results()
        for h in snap.history:
            rec = StepRecord(k=h["k"], t=h["t"], levels=dict(h["levels"]),
                             depths=dict(h["depths"]),
                             gate_open=dict(h["gate_open"]),
                             gate_flow=dict(h["gate_flow"]),
                             pump_flow=dict(h["pump_flow"]),
                             pump_load=dict(h["pump_load"]),
                             interlock_closed=dict(h["interlock_closed"]))
            self.results.records.append(rec)
        if not snap.history:
            self._record()
