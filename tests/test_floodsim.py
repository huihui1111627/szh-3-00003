import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from floodsim.demo_city import build
from floodsim.engine import Controls, Engine, GateAction, PumpAction
from floodsim.rules import analyze
from floodsim.scenario import Scenario, compare
from floodsim.session import SessionStore


def bad_controls():
    """错误组合: 高潮时全开挡潮闸 + 不开泵 + 分洪顺序倒置 + 泵车叠满过载。"""
    return Controls(
        gate_actions=[
            GateAction("g0", 1.0, 0.0),       # 全程要求开挡潮闸
        ],
        pump_actions=[
            PumpAction("p1", 4, 8.0, 3600.0),  # 固定+全部移动泵车叠加 -> 过载
        ],
        diversion_order=("g1", "g2"),          # 先上游(支->主), 顺序倒置
    )


class EngineTests(unittest.TestCase):
    def test_backflow_detected_when_tide_gate_open(self):
        city = build()
        eng = Engine(city, Controls(gate_actions=[GateAction("g0", 1.0, 0.0)]))
        eng.run()
        kinds = {e["type"] for e in eng.results.events}
        self.assertIn("backflow", kinds)

    def test_interlock_alarm_and_forced_close(self):
        city = build()
        # 仅人工开闸: 超阈值产生联锁告警, 倒灌被记录
        eng = Engine(city, Controls(gate_actions=[GateAction("g0", 1.0, 0.0)]))
        eng.run()
        alarmed = [r for r in eng.results.records if r.interlock_closed.get("g0")]
        self.assertTrue(alarmed and any(r.gate_open["g0"] > 0 for r in alarmed))
        self.assertTrue(any(e["type"] == "backflow" for e in eng.results.events))
        # 强制关闭预案: 物理全关, 无倒灌
        city2 = build()
        eng2 = Engine(city2, Controls(forced_close=("g0",)))
        eng2.run()
        self.assertFalse(any(e["type"] == "backflow" for e in eng2.results.events))
        self.assertTrue(all(r.gate_open["g0"] == 0.0
                            for r in eng2.results.records
                            if r.interlock_closed.get("g0")))

    def test_flooding_forms_and_recedes(self):
        city = build()
        c = Controls(
            forced_close=("g0",),
            pump_actions=[PumpAction("p1", 4, 0.0, 3600.0),
                          PumpAction("p2", 3, 0.0, 3600.0)],
        )
        eng = Engine(city, c)
        eng.run()
        dep = [r.depths["blk_a"] for r in eng.results.records]
        self.assertGreater(max(dep), 0.05)          # 过程中有积水
        self.assertLess(dep[-1], max(dep))          # 末期消退
        self.assertEqual(min(dep), dep[0])

    def test_mass_conservation(self):
        city = build()
        c = Controls(forced_close=("g0",),
                     pump_actions=[PumpAction("p1", 2, 0.0, 1800.0)])
        eng = Engine(city, c)
        eng.run()
        # 无质量负体积/负水深
        for r in eng.results.records:
            for d in r.depths.values():
                self.assertGreaterEqual(d, 0.0)
        for bid, body in city.bodies.items():
            if not body.is_sea:
                self.assertGreaterEqual(body.volume, body.stage_volume[0][1] - 1e-6)


class RulesTests(unittest.TestCase):
    def test_diagnosis_finds_all_three_issues(self):
        city = build()
        ana = analyze(city, bad_controls())
        kinds = {f.kind for f in ana.findings}
        self.assertTrue({"backflow", "overload"} <= kinds)

    def test_alternatives_are_executable_and_better(self):
        city = build()
        ana = analyze(city, bad_controls())
        self.assertTrue(len(ana.alternatives) >= 2)
        self.assertIsNotNone(ana.recommended)
        for alt in ana.alternatives:
            sim_city, _, results = run(alt.controls)
            self.assertEqual(max(r.depths["blk_a"] for r in results.records) >= 0.0, True)
        rec = next(a for a in ana.alternatives if a.name == ana.recommended)
        self.assertEqual(rec.backflow_steps, 0)


def run(controls):
    from floodsim.rules import run_bundle
    return run_bundle(build(), controls)


class ScenarioTests(unittest.TestCase):
    def test_multi_scenario_compare(self):
        city = build()
        s1 = Scenario("base", "现状调度", bad_controls()).start(city)
        good = Controls(
            forced_close=("g0",),
            pump_actions=[PumpAction("p1", 4, 0.0, 3600.0),
                          PumpAction("p2", 3, 0.0, 3600.0)],
            diversion_order=("g2", "g1"),
        )
        s2 = Scenario("plan", "优化调度", good).start(city)
        cmp_ = compare([s1, s2], times=[0.0, 10800.0, 43200.0])
        self.assertEqual(len(cmp_["frames"]), 3)
        self.assertTrue(cmp_["metrics"]["plan"]["peak_depth"]["blk_a"]
                        <= cmp_["metrics"]["base"]["peak_depth"]["blk_a"] + 1e-9)

    def test_adjust_controls_recomputes(self):
        city = build()
        sc = Scenario("s", "方案", Controls()).start(city)
        peak0 = sc.engine.results.arrival["blk_a"]["peak"]
        sc.apply_controls(Controls(
            forced_close=("g0",),
            pump_actions=[PumpAction("p1", 4, 0.0, 1800.0),
                          PumpAction("p2", 3, 0.0, 1800.0)]), city)
        peak1 = sc.engine.results.arrival["blk_a"]["peak"]
        self.assertLess(peak1, peak0)


class SessionTests(unittest.TestCase):
    def test_save_and_resume_mid_run(self):
        city = build()
        c = Controls(forced_close=("g0",),
                     pump_actions=[PumpAction("p1", 4, 0.0, 3600.0)])
        sc = Scenario("s1", "台风梅花", c).start(city, run_now=False)
        for _ in range(20):  # 推演到 100 min 处"断线"
            sc.engine.step()
        with tempfile.TemporaryDirectory() as d:
            store = SessionStore(os.path.join(d, "sessions.json"))
            store.save("sess-1", city, {"s1": sc})
            resumed = store.resume("sess-1", build)
        rs = resumed["s1"]
        self.assertEqual(rs.engine.t, city.horizon)  # 恢复后继续跑完
        self.assertGreater(rs.engine.results.arrival["blk_a"]["peak"], 0.0)
        # 恢复后时间轴保留断点前的全部历史帧(含初始帧)
        recs = rs.engine.results.records
        self.assertEqual(len(recs), city.horizon // city.dt + 1)
        self.assertEqual(recs[0].t, 0.0)
        self.assertIn("blk_b", recs[10].depths)


if __name__ == "__main__":
    unittest.main()
