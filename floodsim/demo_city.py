"""示例沿海城市水网(12 h 台风+大潮过程)。

拓扑:
  sea <-潮闸 G0- main <-分洪闸 G1- trib <-分洪闸 G2- basin(蓄滞洪区)
  sea <-河口泵站 P1- main ; block_a --拍门自排--> main
  block_b --拍门自排/泵站 P2--> trib
"""

from __future__ import annotations

from .model import Block, City, Gate, Interlock, PumpStation, Rainfall, WaterBody

DT = 300          # 5 min 一步
HORIZON = 43200  # 12 h


def _rect_sv(area_m2, h0=-3.0, h1=12.0, step=0.5):
    return [(round(h, 2), max(0.0, (h - h0) * area_m2))
            for h in _frange(h0, h1, step)]


def _frange(start, stop, step):
    n = int(round((stop - start) / step))
    return [start + i * step for i in range(n + 1)]


def build() -> City:
    city = City(dt=DT, horizon=HORIZON)

    # 潮位: 6h 涨到 3.8m 高潮位, 再回落
    tide = [(0, 0.2), (HORIZON * 0.5, 3.8), (HORIZON, 0.4)]
    sea = WaterBody("sea", "外海", _rect_sv(1e9), is_sea=True, tide_series=tide)
    # 主河道 60 万 m2 水面, 支流 25 万 m2, 蓄滞洪区 120 万 m2
    main = WaterBody("main", "主河道", _rect_sv(1.2e6), initial_level=0.3,
                     upstream_inflow=[(0, 20), (HORIZON * 0.35, 260),
                                      (HORIZON * 0.7, 80), (HORIZON, 40)])
    trib = WaterBody("trib", "支流", _rect_sv(6e5), initial_level=0.2,
                     upstream_inflow=[(0, 10), (HORIZON * 0.3, 120),
                                      (HORIZON * 0.7, 40), (HORIZON, 15)])
    basin = WaterBody("basin", "蓄滞洪区", _rect_sv(1.2e6), initial_level=-1.5,
                      is_detention=True)
    city.bodies.update({"sea": sea, "main": main, "trib": trib, "basin": basin})

    # 降雨: 2h 起涨, 4.5h 峰值 90mm/h, 8h 结束
    rain = [(0, 0.0), (7200, 30.0), (14400, 110.0), (21600, 100.0),
            (28800, 10.0), (HORIZON, 0.0)]
    city.rainfall = Rainfall(series=rain, block_factor={"blk_b": 1.15},
                             block_offset={"blk_a": 55.0})

    # 闸
    city.gates.update({
        "g0": Gate("g0", "海口挡潮闸", "main", "sea", width=12.0, crest=-1.5,
                   kind="tide"),
        "g1": Gate("g1", "干支分洪闸", "trib", "main", width=8.0, crest=1.8,
                   kind="diversion"),
        "g2": Gate("g2", "蓄滞洪区进水闸", "trib", "basin", width=10.0,
                   crest=1.6, kind="diversion"),
    })
    # 潮位 2.2m 触发挡潮联锁
    city.interlocks = [Interlock("g0", trigger_level=2.0)]

    # 泵站
    city.stations.update({
        "p1": PumpStation("p1", "1号河口泵站", "main", "sea",
                          unit_capacity=25.0, unit_count=4, mobile_capacity=20.0),
        "p2": PumpStation("p2", "2号排涝泵站", "blk_b", "trib",
                          unit_capacity=2.5, unit_count=2, mobile_capacity=4.0),
    })

    # 街区: 面积约 0.8 / 0.5 km2, 地面 2.4/2.6 m, 拍门自排
    city.blocks.update({
        "blk_a": Block("blk_a", "海港街区", area=4e5, ground_level=1.8,
                       drain_to="main", drain_width=4.0, drain_crest=1.0),
        "blk_b": Block("blk_b", "老城街区", area=5e5, ground_level=2.6,
                       drain_to="trib", drain_width=4.0, drain_crest=0.4),
    })
    # 街区拍门
    city.gates["d_a"] = Gate("d_a", "海港街拍门", "blk_a", "main",
                             width=4.0, crest=1.0, kind="block", cw=0.5)
    city.gates["d_b"] = Gate("d_b", "老城街拍门", "blk_b", "trib",
                             width=4.0, crest=0.4, kind="block", cw=0.5)
    city.reset()
    return city
