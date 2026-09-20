# 潮汐防洪推演参考实现

面向沿海城市的潮汐防洪推演内核: 同屏表达降雨、潮位、河道水位、泵站负荷与
闸门状态, 支持时间轴回放积水形成/消退、运行中调整调度并重新预测各街区淹没
深度与到达时间、倒灌/过载/上下游冲突的成因解释与可执行替代组合、多方案同步
比较, 以及意外断开后的快照恢复。

零依赖, Python 3.9+。

## 运行

```bash
python3 demo.py                       # 端到端演示
python3 -m unittest discover -s tests # 9 个用例
```

## 代码结构

- `floodsim/model.py` — 水网拓扑(水体/闸/泵站/街区/雨潮边界/联锁)
- `floodsim/engine.py` — 步进求解、增量重算、事件检测、快照
- `floodsim/rules.py` — 风险诊断、成因解释、替代组合生成与评分
- `floodsim/scenario.py` — 多方案生命周期、同步比较、时间轴导出
- `floodsim/session.py` — JSON 原子落盘与断点续演
- `floodsim/demo_city.py` — 示例城市(12h 台风 + 大潮)
- `docs/design.md` — 完整技术方案(架构、模型、交互、工程落地)

## 最小用法

```python
from floodsim.demo_city import build
from floodsim.engine import Controls, GateAction, PumpAction
from floodsim.rules import analyze

city = build()
controls = Controls(
    gate_actions=[GateAction("g0", 1.0, 0)],       # 错误地全程开挡潮闸
    pump_actions=[PumpAction("p1", 4, 20.0, 3600)],
    diversion_order=("g1", "g2"),
)
report = analyze(city, controls)
for f in report.findings:
    print(f.severity, f.kind, f.reason, "->", f.suggestion)
best = next(a for a in report.alternatives if a.name == report.recommended)
```
