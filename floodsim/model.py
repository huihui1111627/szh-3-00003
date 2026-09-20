"""水网拓扑定义。

约定:
  长度 m, 面积 m^2, 水位/高程 m, 流量 m^3/s, 降雨强度 mm/h。
  城市由若干"水体"(河道/蓄滞洪区/虚拟海)、闸门、泵站、街区组成,
  构成一个有向输水网络; 时间步内按显式质量平衡推进。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Tuple

G = 9.81


def interp_series(series: List[Tuple[float, float]], t: float) -> float:
    """分段线性取值, 两端按边界值延拓。series 已按时间升序。"""
    if t <= series[0][0]:
        return series[0][1]
    if t >= series[-1][0]:
        return series[-1][1]
    for i in range(1, len(series)):
        t1, v1 = series[i]
        if t <= t1:
            t0, v0 = series[i - 1]
            f = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
            return v0 + (v1 - v0) * f
    return series[-1][1]


@dataclass
class Rainfall:
    """城市统一降雨过程线, 各街区可乘独立折减系数。"""

    series: List[Tuple[float, float]] = field(default_factory=list)  # (s, mm/h)
    block_factor: Dict[str, float] = field(default_factory=dict)
    block_offset: Dict[str, float] = field(default_factory=dict)

    def intensity(self, t: float, block_id: str) -> float:
        base = interp_series(self.series, t)
        return max(0.0, base * self.block_factor.get(block_id, 1.0)
                   - self.block_offset.get(block_id, 0.0))


@dataclass
class WaterBody:
    """水量节点: 河道、蓄滞洪区或虚拟海。

    level 由体积经 stage-volume 表线性插值得到;
    sea=True 时为边界水体, 水位由潮位过程驱动, 体积不参与平衡。
    """

    id: str
    name: str
    stage_volume: List[Tuple[float, float]]  # (水位 m, 体积 m3), 升序
    initial_level: float = 0.0
    is_sea: bool = False
    tide_series: List[Tuple[float, float]] = field(default_factory=list)
    upstream_inflow: List[Tuple[float, float]] = field(default_factory=list)
    is_detention: bool = False
    level: float = 0.0
    volume: float = 0.0

    def level_of(self, volume: float) -> float:
        sv = self.stage_volume
        if volume <= sv[0][1]:
            return sv[0][0]
        if volume >= sv[-1][1]:
            return sv[-1][0]
        for i in range(1, len(sv)):
            h1, v1 = sv[i]
            if volume <= v1:
                h0, v0 = sv[i - 1]
                f = (volume - v0) / (v1 - v0) if v1 > v0 else 0.0
                return h0 + (h1 - h0) * f
        return sv[-1][0]

    def tide_level(self, t: float) -> float:
        if not self.is_sea:
            raise ValueError(f"{self.id} 不是海域边界")
        return interp_series(self.tide_series, t)

    def inflow_at(self, t: float) -> float:
        if not self.upstream_inflow:
            return 0.0
        return interp_series(self.upstream_inflow, t)


@dataclass
class Gate:
    """闸/堰/拍门类连接。

    kind:
      tide      出海挡潮闸, 可被联锁强制关闭(倒灌保护)
      diversion 河道间分洪闸, 受全局分洪顺序约束
      block     街区向河道排水的拍门/闸, 自动单向开启
      plain     普通河闸
    宽顶堰流: Q = cw * w * sqrt(g) * h^1.5 (上游水头 h, 自由/淹没取小)。
    """

    id: str
    name: str
    src: str
    dst: str
    width: float
    crest: float
    kind: str = "plain"
    opening: float = 0.0          # 0..1 初始开度
    cw: float = 0.55              # 宽顶堰流量系数


@dataclass
class PumpStation:
    """泵站: 组合开启若干机组, 总排水能力 = 单机容量 × 开启台数。"""

    id: str
    name: str
    src: str
    dst: str
    unit_capacity: float          # m3/s 单台
    unit_count: int
    mobile_capacity: float = 0.0  # m3/s 可增援移动泵车
    on_units: int = 0
    mobile_on: float = 0.0
    overload_threshold: float = 1.0  # 实际负荷/额定能力 告警阈值
    energy_per_m3: float = 0.0006    # kWh/m3, 用于方案能耗评分


@dataclass
class Block:
    """汇水街区: 地面调蓄 + 向受纳河道排水。

    淹没水深 = 积水量 / 汇水面积; 通过 block 类拍门自排(受河道水位顶托),
    以及排入泵站的流量由泵站连接决定(泵站 src 指向街区)。
    """

    id: str
    name: str
    area: float                   # m2
    ground_level: float           # m 地面高程
    drain_to: str                 # 自排受纳水体 id
    drain_width: float = 3.0
    drain_crest: float = 0.0
    drain_cw: float = 0.5
    initial_depth: float = 0.0
    # 运行期状态
    depth: float = 0.0

    @property
    def water_level(self) -> float:
        return self.ground_level + self.depth


@dataclass
class Interlock:
    """挡潮联锁: 当外海潮位 >= trigger_level 时强制关闭指定闸门。"""

    gate_id: str
    trigger_level: float


@dataclass
class City:
    dt: int                                   # 时间步长 s
    horizon: int                              # 推演时长 s
    bodies: Dict[str, WaterBody] = field(default_factory=dict)
    gates: Dict[str, Gate] = field(default_factory=dict)
    stations: Dict[str, PumpStation] = field(default_factory=dict)
    blocks: Dict[str, Block] = field(default_factory=dict)
    rainfall: Rainfall = field(default_factory=Rainfall)
    interlocks: List[Interlock] = field(default_factory=list)

    # ---- 拓扑辅助 ----
    def gate(self, gate_id: str) -> Gate:
        return self.gates[gate_id]

    def station(self, station_id: str) -> PumpStation:
        return self.stations[station_id]

    def tidal_gates(self) -> List[Gate]:
        return [g for g in self.gates.values() if g.kind == "tide"]

    def diversion_gates(self) -> List[Gate]:
        return [g for g in self.gates.values() if g.kind == "diversion"]

    def reset(self) -> None:
        for b in self.bodies.values():
            if not b.is_sea:
                b.level = b.initial_level
                b.volume = self._volume_at(b, b.initial_level)
        for blk in self.blocks.values():
            blk.depth = blk.initial_depth
        for g in self.gates.values():
            g.opening = 1.0 if g.kind == "block" else 0.0

    @staticmethod
    def _volume_at(body: WaterBody, level: float) -> float:
        sv = body.stage_volume
        if level <= sv[0][0]:
            return sv[0][1]
        if level >= sv[-1][0]:
            return sv[-1][1]
        for i in range(1, len(sv)):
            h1, v1 = sv[i]
            if level <= h1:
                h0, v0 = sv[i - 1]
                f = (level - h0) / (h1 - h0) if h1 > h0 else 0.0
                return v0 + (v1 - v0) * f
        return sv[-1][1]
