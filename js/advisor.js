/* 智能调度顾问：识别告警 → 生成可执行替代组合 → 重新推演 → 打分排序 */
(function (global) {
  'use strict';
  var GEO = global.GEO, E1 = global.SIM_ENGINE_PART1;

  function scoreOf(m) {
    // 0~100，越高越好。权重：最大淹深、淹没面积、倒灌、漫溢、过载/冲突历时、能耗
    var depthP = Math.max(0, 100 - m.worstDepth / 0.6 * 55);
    var areaP = Math.max(0, 100 - m.floodedAreaHa / 350 * 45);
    var backP = 100 - Math.min(100, m.backflowVol / 3000000 * 100);
    var overP = 100 - Math.min(100, m.overflowVol / 200000 * 100);
    var stepPenalty = (m.overloadSteps + m.conflictSteps) / GEO.totalSteps() * 100;
    var riskP = Math.max(0, 100 - stepPenalty * 1.2);
    var energyP = 100 - Math.min(40, m.energyKwh / 500000 * 40);
    return {
      total: depthP * 0.30 + areaP * 0.22 + backP * 0.18 + overP * 0.12 + riskP * 0.12 + energyP * 0.06,
      parts: { depthP: depthP, areaP: areaP, backP: backP, overP: overP, riskP: riskP, energyP: energyP }
    };
  }

  // —— 三套预设替代组合 ——
  function planA1() { // 御潮优先
    var p = E1.defaultPlan();
    p.gates.G0 = { mode: 'manual', open: 1.0, periods: [
      { from: 0.5, to: 5.0, open: 0 }, { from: 12.8, to: 18.8, open: 0 },
      { from: 25.0, to: 30.8, open: 0 }, { from: 37.4, to: 43.2, open: 0 }
    ] };
    GEO.DRAIN_GATES.forEach(function (g) { p.gates[g.id] = { mode: 'auto', open: 1.0 }; });
    GEO.PUMPS.forEach(function (pu) { p.pumps[pu.id] = { on: true, units: pu.units }; });
    p.gates.D2 = { mode: 'manual', open: 0.5, startH: 19, endH: 30 };
    p.gates.D1 = { mode: 'manual', open: 0.6, startH: 20, endH: 32 };
    p.diversions = [{ basin: 'd2', startH: 19, open: 0.5 }, { basin: 'd1', startH: 20, open: 0.6 }];
    return p;
  }

  function planA2() { // 主动分洪
    var p = planA1();
    p.gates.G0 = { mode: 'auto', open: 1.0 };
    p.gates.D2 = { mode: 'manual', open: 0.9, startH: 12, endH: 30 };
    p.gates.D1 = { mode: 'manual', open: 0.9, startH: 12, endH: 34 };
    p.diversions = [{ basin: 'd1', startH: 12, open: 0.9 }, { basin: 'd2', startH: 12, open: 0.9 }];
    return p;
  }

  function planA3() { // 低投入（局部强排+关闸）
    var p = E1.defaultPlan();
    p.gates.G0 = { mode: 'auto', open: 1.0 };
    GEO.DRAIN_GATES.forEach(function (g) { p.gates[g.id] = { mode: 'auto', open: 1.0 }; });
    ['p2', 'p7', 'p1', 'p3'].forEach(function (pid) {
      var pu = GEO.byId[pid];
      p.pumps[pid] = { on: true, units: pu.units };
    });
    p.gates.D1 = { mode: 'manual', open: 0.0 };
    p.gates.D2 = { mode: 'manual', open: 0.0 };
    return p;
  }

  var PRESETS = [
    { id: 'a1', name: '御潮优先：高潮关闸 + 全面强排 + 错峰分洪', desc: '挡潮闸按潮时启闭，自排闸全部改自动防倒灌，7 座泵站全开，两场峰后启用双蓄滞洪区。', build: planA1 },
    { id: 'a2', name: '主动分洪：自动挡潮 + 两片区提前进洪', desc: '挡潮闸自动落闸，12h 起西郊、北湖同步大进洪，削峰最积极，占用蓄滞容积最多。', build: planA2 },
    { id: 'a3', name: '低投入：自动闸控 + 重点泵站强排', desc: '不启用蓄滞洪区，仅开启河口、南湖、临江、老城 4 处泵站，能耗最低、适合风险可控情景。', build: planA3 }
  ];

  // 针对当前方案的告警，逐条给出“原因 → 动作”的规则解释
  function explain(warnings) {
    var byKind = {};
    warnings.forEach(function (w) {
      (byKind[w.kind] = byKind[w.kind] || []).push(w);
    });
    var tips = [];
    if (byKind.backflow) {
      var g0w = byKind.backflow.filter(function (w) { return w.key === 'BF-G0'; });
      if (g0w.length) tips.push({
        action: '挡潮闸改为按潮时启闭（高潮位前落闸），或将 G0 切到自动模式',
        reason: g0w.length + ' 个潮周期内潮位高于内河，' + g0w.length + ' 次海水经 G0 倒灌，顶托主河道并抬高街区水位'
      });
      var gw = byKind.backflow.filter(function (w) { return /^BF-g/.test(w.key); });
      if (gw.length) tips.push({
        action: '相关自排闸改“自动（防倒灌）”，并开启对应泵站强排',
        reason: gw.length + ' 处自排闸在河水高于街区地面时仍开启，河水反向进入城区，是低洼片积水的主因'
      });
      var dw = byKind.backflow.filter(function (w) { return /^BF-D/.test(w.key); });
      if (dw.length) tips.push({
        action: '推迟分洪闸门开启时刻，待潮位回落后再进洪',
        reason: dw.length + ' 处分洪渠在河道高水位时反向过流，提前分洪不仅未削峰反而占用/扰动蓄滞容积'
      });
    }
    if (byKind.overload) tips.push({
      action: '增加在线泵站与开机台数，或提前预排降低内河水位',
      reason: byKind.overload.length + ' 座泵站来水需求超过装机能力，过载时段抽排能力不足导致积水加深'
    });
    if (byKind.conflict) tips.push({
      action: '高潮关闸同时启用蓄滞洪区错峰承泄，并加大泵站抢排',
      reason: byKind.conflict.length + ' 类上下游调度冲突：关闸御潮与上游来水下泄、自排与强排、分洪时序之间互相矛盾'
    });
    if (byKind.overflow) tips.push({
      action: '减小该蓄滞洪区闸门开度，切换到另一片区分洪',
      reason: byKind.overflow.length + ' 处蓄滞洪区出现漫溢风险，进洪量超过调蓄能力'
    });
    return tips;
  }

  function evaluate(geo, scenario, plan) {
    var res = global.SIM_RUN.run(geo, scenario, plan);
    var sc = scoreOf(res.metrics);
    return { plan: plan, result: res, score: sc.total, parts: sc.parts };
  }

  // 为方案生成并排序替代组合（去重，按得分）
  function recommend(geo, scenario, currentPlan, currentResult) {
    var base = evaluate(geo, scenario, currentPlan);
    var cands = PRESETS.map(function (ps) {
      var ev = evaluate(geo, scenario, ps.build());
      return { id: ps.id, name: ps.name, desc: ps.desc, ev: ev };
    });
    cands.sort(function (a, b) { return b.ev.score - a.ev.score; });
    return {
      base: base,
      tips: explain(currentResult.warnings),
      alternatives: cands
    };
  }

  global.ADVISOR = { scoreOf: scoreOf, explain: explain, evaluate: evaluate, recommend: recommend, PRESETS: PRESETS };
})(typeof window !== 'undefined' ? window : globalThis);
