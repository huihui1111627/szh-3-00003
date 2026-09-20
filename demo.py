"""端到端演示: 错误调度 -> 诊断解释 -> 替代组合 -> 多方案比较 -> 断点续演。

运行: python3 demo.py
"""

import os
import tempfile

from floodsim.demo_city import build
from floodsim.engine import Controls, GateAction, PumpAction
from floodsim.rules import analyze
from floodsim.scenario import Scenario, compare
from floodsim.session import SessionStore


def hms(t):
    return f"{int(t // 3600):02d}:{int(t % 3600 // 60):02d}"


def main():
    city = build()
    print("=" * 70)
    print("场景: 12 小时台风暴雨 + 天文大潮, 推演步长 5 min")
    print("=" * 70)

    # 1) 值班员的初始(错误)调度: 高潮时开挡潮闸、泵车叠满、分洪顺序倒置
    bad = Controls(
        gate_actions=[GateAction("g0", 1.0, 0.0)],
        pump_actions=[PumpAction("p1", 4, 20.0, 3600.0)],
        diversion_order=("g1", "g2"),
    )
    print("\n[初始调度] 挡潮闸全程开启 + 1号泵固定机组+全部泵车 + 先开干支闸")
    ana = analyze(city, bad)

    print("\n-- 街区预测 --")
    for bid, s in ana.block_stats.items():
        arr = hms(s["arrival"]) if s["arrival"] is not None else "未积水"
        print(f"  {city.blocks[bid].name}: 峰值水深 {s['peak']:.2f} m, "
              f"到达时间 {arr}, 峰现 {hms(s['peak_time'])}")

    print("\n-- 风险诊断(含成因解释) --")
    for f in ana.findings:
        t = f" t={hms(f.time)}" if f.time is not None else ""
        print(f"  [{f.severity.upper():6s}] {f.kind:8s} {f.target}{t}")
        print(f"      成因: {f.reason}")
        print(f"      建议: {f.suggestion}")

    print(f"\n-- 系统推荐替代组合: {ana.recommended} --")
    for alt in ana.alternatives:
        peaks = ", ".join(f"{city.blocks[b].name} {v:.2f}m"
                          for b, v in alt.peak_depth.items())
        print(f"  {alt.name:14s} 风险分 {alt.score:7.1f}  最高负荷 {alt.max_load:.0%}"
              f"  倒灌 {alt.backflow_steps} 步 | {peaks}")
        print(f"      {alt.rationale}")

    # 2) 多方案同步回放比较
    base = Scenario("base", "原调度", bad).start(city)
    rec_alt = next(a for a in ana.alternatives if a.name == ana.recommended)
    plan = Scenario("plan", ana.recommended, rec_alt.controls).start(city)
    cmp_ = compare([base, plan], times=[0.0, 10800.0, 21600.0, 43200.0])
    print("\n-- 同步回放比较(水深 m) --")
    print(f"  {'时刻':>6s} | {'原调度 海港/老城':>18s} | {'推荐方案 海港/老城':>20s}")
    for i, t in enumerate(cmp_["times"]):
        f0, f1 = cmp_["frames"][i]
        print(f"  {hms(t):>6s} | {f0['depths']['blk_a']:8.2f} / {f0['depths']['blk_b']:.2f}"
              f"       | {f1['depths']['blk_a']:8.2f} / {f1['depths']['blk_b']:.2f}")

    # 3) 运行中调整 -> 重新预测
    print("\n-- 运行中调整: 值班员又给 2 号泵站追加 4 m3/s 移动泵车, 重新预测 --")
    import copy
    tweaked = copy.deepcopy(rec_alt.controls)
    tweaked.pump_actions.append(
        PumpAction("p2", 2, city.stations["p2"].mobile_capacity, 1800.0))
    plan.apply_controls(tweaked, city)
    new_peak = plan.engine.results.arrival["blk_b"]["peak"]
    old_peak = cmp_["metrics"]["plan"]["peak_depth"]["blk_b"]
    base_peak = cmp_["metrics"]["base"]["peak_depth"]["blk_b"]
    print(f"  老城街区峰值: 原调度 {base_peak:.3f} m -> 推荐 {old_peak:.3f} m"
          f" -> 追加泵车后 {new_peak:.3f} m")
    if abs(new_peak - old_peak) < 0.01:
        print("  系统解释: 残余积水由雨峰瞬时超流与支流高水位顶托拍门造成,")
        print("            再加泵车已无边际收益; 有效替代是提前开启蓄滞洪区 g2 腾出库容。")

    # 4) 断点续演
    with tempfile.TemporaryDirectory() as d:
        store = SessionStore(os.path.join(d, "sessions.json"))
        partial = Scenario("live", "进行中的推演", tweaked).start(city, run_now=False)
        for _ in range(40):
            partial.engine.step()
        store.save("session-001", city, {"live": partial})
        print(f"\n-- 推演至 {hms(partial.engine.t)} 时连接断开, 快照已落盘 --")
        resumed = store.resume("session-001", build)
        rs = resumed["live"]
        print(f"-- 重连后从 {hms(rs.engine.results.records[40].t)} 恢复, "
              f"继续推至 {hms(rs.engine.t)}, 老城峰值 "
              f"{rs.engine.results.arrival['blk_b']['peak']:.2f} m --")


if __name__ == "__main__":
    main()
