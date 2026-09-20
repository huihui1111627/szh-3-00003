"""诊断与替代方案规则引擎。

输入一份 Controls(调度组合), 重新独立跑一遍引擎, 输出:
  1. 结构性冲突(未运行即可判定: 挡潮闸常闭矛盾、分洪顺序越级);
  2. 运行期告警(倒灌、泵站过载、上下游调度冲突);
  3. 各街区淹没深度与到达时间;
  4. 可直接执行的替代 Controls 组合及预期效果。
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .engine import Controls, Engine, GateAction, PumpAction
from .model import City


@dataclass
class Finding:
    kind: str                 # backflow / overload / conflict
    severity: str             # danger / warning
    target: str
    time: Optional[float]
    reason: str
    suggestion: str


@dataclass
class Alternative:
    name: str
    controls: Controls
    rationale: str
    peak_depth: Dict[str, float] = field(default_factory=dict)
    worst_arrival: Optional[float] = None
    max_load: float = 0.0
    backflow_steps: int = 0
    score: float = 0.0


@dataclass
class Analysis:
    findings: List[Finding]
    block_stats: Dict[str, dict]
    alternatives: List[Alternative]
    recommended: Optional[str]


def run_bundle(city: City, controls: Controls):
    """独立副本运行, 不污染当前画布状态。"""
    sim_city = copy.deepcopy(city)
    engine = Engine(sim_city, copy.deepcopy(controls))
    results = engine.run()
    return sim_city, engine, results


def _block_stats(results) -> Dict[str, dict]:
    stats = {}
    for bid, info in results.arrival.items():
        stats[bid] = {
            "arrival": info["arrival"],
            "peak": info["peak"],
            "peak_time": info["peak_time"],
        }
    return stats


def _commanded_open(controls: Controls, t: float) -> Dict[str, float]:
    """重放到 t 时刻人工要求的各闸开度。"""
    cmd: Dict[str, float] = {}
    for a in controls.gate_actions:
        if a.time <= t + 1e-9:
            cmd[a.gate_id] = a.opening
    return cmd


def analyze(city: City, controls: Controls) -> Analysis:
    findings: List[Finding] = []
    sim_city, engine, results = run_bundle(city, controls)

    # ---- 结构性检查: 分洪顺序里引用了不存在的闸 ----
    valid_diversion = {g.id for g in sim_city.diversion_gates()}
    for gid in controls.diversion_order:
        if gid not in valid_diversion:
            findings.append(Finding(
                "conflict", "danger", gid, None,
                f"分洪顺序引用了不存在或非分洪闸 '{gid}', 该级及后续分洪均不会开启",
                "从分洪序列中移除该闸, 或先在拓扑中补建连接"))

    # ---- 运行期: 倒灌 ----
    for ev in results.events:
        if ev["type"] == "backflow":
            gid = ev["gate"]
            gate = sim_city.gates[gid]
            if gate.kind != "tide":
                continue
            findings.append(Finding(
                "backflow", "danger", gid, ev["time"], ev["message"],
                f"在涨潮段将 {gate.name} 纳入挡潮联锁/强制关闭, 改用泵站强排; "
                f"落潮且外河水位低于内河 0.2 m 后再开闸抢排"))
        elif ev["type"] == "overload":
            sid = ev["station"]
            findings.append(Finding(
                "overload", "warning", sid, ev["time"], ev["message"],
                "固定机组优先满发, 移动泵车分两批错峰投入; 或将部分流量改由相邻泵站分担"))

    # ---- 运行期: 人工开闸与挡潮联锁冲突 ----
    for rec in results.records:
        cmd = _commanded_open(controls, rec.t)
        for gid, locked in rec.interlock_closed.items():
            if locked and cmd.get(gid, 0.0) > 0.0:
                trigger = next(lk.trigger_level for lk in sim_city.interlocks
                               if lk.gate_id == gid)
                findings.append(Finding(
                    "conflict", "warning", gid, rec.t,
                    f"t={rec.t:.0f}s 人工指令开启 {sim_city.gates[gid].name}, "
                    f"但外潮位已达联锁阈值({trigger:.1f} m), "
                    f"挡潮联锁应动作, 继续开闸将发生海水倒灌",
                    "立即关闭该闸并启用强制关闭预案; 排涝需求紧迫时改用泵站抽排"))
                break
        else:
            continue
        break

    # ---- 运行期: 上下游冲突(分洪通道被下游顶托) ----
    for gate in sim_city.diversion_gates():
        for rec in results.records:
            if rec.gate_open.get(gate.id, 0.0) <= 0.0:
                continue
            q = rec.gate_flow.get(gate.id, 0.0)
            h_up = rec.levels.get(gate.src)
            h_down = rec.levels.get(gate.dst)
            if h_up is None or h_down is None:
                continue
            head = h_up - gate.crest
            if head > 0.1 and h_down >= gate.crest + 0.5 * head and q < 0.2 * max(head, 1e-9) ** 1.5 * gate.width:
                findings.append(Finding(
                    "conflict", "danger", gate.id, rec.t,
                    f"t={rec.t:.0f}s 分洪闸 {gate.name} 已开启但下泄仅 {q:.1f} m3/s: "
                    f"下游 {gate.dst} 水位 {h_down:.2f} m 顶托, 上游继续分洪将壅水",
                    "按'先下游后上游'重排分洪顺序, 先开启近海口通道/蓄滞洪区预降水位, "
                    "再开启上游分洪闸"))
                break

    stats = _block_stats(results)
    alternatives, recommended = _build_alternatives(city, controls, stats, findings)
    return Analysis(findings, stats, alternatives, recommended)


def _evaluate(city: City, controls: Controls, name: str, rationale: str) -> Alternative:
    sim_city, _, results = run_bundle(city, controls)
    peak = {bid: info["peak"] for bid, info in results.arrival.items()}
    arrivals = [info["arrival"] for info in results.arrival.values() if info["arrival"]]
    backflow_steps = sum(1 for e in results.events
                         if e["type"] == "backflow"
                         and sim_city.gates[e["gate"]].kind == "tide")
    max_load = 0.0
    for rec in results.records:
        max_load = max(max_load, max(rec.pump_load.values(), default=0.0))
    alt = Alternative(
        name=name, controls=controls, rationale=rationale,
        peak_depth=peak,
        worst_arrival=min(arrivals) if arrivals else None,
        max_load=max_load,
        backflow_steps=backflow_steps,
    )
    peak_penalty = sum(max(0.0, d - 0.15) for d in peak.values())
    alt.score = round(100.0 * peak_penalty + 500.0 * backflow_steps + 20.0 * max(0.0, max_load - 1.0), 2)
    return alt


def _downstream_order(city: City) -> List[str]:
    """按'离海最近优先'对分洪闸排序: 先开下游通道, 避免顶托。"""
    sea = {bid for bid, b in city.bodies.items() if b.is_sea}
    graph: Dict[str, List[str]] = {}
    for g in city.gates.values():
        graph.setdefault(g.src, []).append(g.dst)
    dist: Dict[str, int] = {}
    frontier = list(sea)
    for s in frontier:
        dist[s] = 0
    while frontier:
        nxt = []
        for node in frontier:
            for up, downs in graph.items():
                if node in downs and up not in dist:
                    dist[up] = dist[node] + 1
                    nxt.append(up)
        frontier = nxt
    gates = list(city.diversion_gates())
    gates.sort(key=lambda g: (dist.get(g.dst, 99), dist.get(g.src, 99), g.id))
    return [g.id for g in gates]


def _pump_lead(city: City) -> float:
    """降雨/洪水起峰前 30 分钟启泵预排。"""
    start = city.horizon
    for t, intensity in city.rainfall.series:
        if intensity > 1.0:
            start = min(start, t)
    for body in city.bodies.values():
        for t, q in body.upstream_inflow:
            if q > 0.0:
                start = min(start, t)
    return max(0.0, start - 1800.0)


def _build_alternatives(city, base_controls, base_stats, findings):
    kinds = {f.kind for f in findings}
    alts: List[Alternative] = []

    def clone():
        return copy.deepcopy(base_controls)

    if "backflow" in kinds or "conflict" in kinds:
        c = clone()
        c.forced_close = tuple(g.id for g in city.tidal_gates())
        c.gate_actions = [a for a in c.gate_actions
                          if city.gates[a.gate_id].kind != "tide"]
        lead = _pump_lead(city)
        c.pump_actions = []
        for st in city.stations.values():
            c.pump_actions.append(PumpAction(st.id, st.unit_count, 0.0, lead))
            if st.mobile_capacity > 0:
                c.pump_actions.append(
                    PumpAction(st.id, st.unit_count, st.mobile_capacity, lead + 1800.0))
        alts.append(_evaluate(
            city, c, "A 挡潮强排",
            "涨潮期挡潮闸联锁常闭杜绝倒灌; 全部固定机组潮前 30 min 启泵预排, "
            "移动泵车延后 30 min 错峰投入避免叠加过载"))

    conflict_gate_ids = {f.target for f in findings
                         if f.kind == "conflict" and f.target in city.gates
                         and city.gates[f.target].kind == "diversion"}
    if conflict_gate_ids or "backflow" in kinds:
        c = clone()
        c.diversion_order = tuple(_downstream_order(city))
        alts.append(_evaluate(
            city, c, "B 先下后上分洪",
            "按离海距离自近而远重排分洪顺序, 下游通道/蓄滞洪区先行开启预降水位, "
            "消除对上游分洪闸的顶托"))

    if len(alts) >= 2:
        c = copy.deepcopy(alts[0].controls)
        c.diversion_order = tuple(_downstream_order(city))
        alts.append(_evaluate(
            city, c, "C 组合方案",
            "挡潮强排 + 先下后上分洪同时生效, 兼顾潮位顶托与上游来水"))

    if "overload" in kinds and not any(a.name.startswith("A") for a in alts):
        c = clone()
        lead = _pump_lead(city)
        c.pump_actions = []
        for st in city.stations.values():
            c.pump_actions.append(PumpAction(st.id, st.unit_count, 0.0, lead))
            if st.mobile_capacity > 0:
                c.pump_actions.append(
                    PumpAction(st.id, st.unit_count, st.mobile_capacity * 0.5, lead + 1800.0))
        alts.append(_evaluate(
            city, c, "A 错峰启泵",
            "固定机组先满发, 移动泵车减半且延后 30 min 投入, 控制总负荷不超过额定"))

    if alts:
        best = min(alts, key=lambda a: a.score)
        return alts, best.name
    return [], None
