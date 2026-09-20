/* 主推演循环：边界条件 → 工程调度 → 逐子步水量平衡 → 状态/告警/指标 */
(function (global) {
  'use strict';
  var GEO = global.GEO;
  var CORE = global.SIM_CORE;

  function clonePlan(p) {
    return JSON.parse(JSON.stringify(p));
  }

  function defaultPlan() {
    var plan = { gates: {}, pumps: {}, diversions: [] };
    plan.gates[GEO.TIDE_GATE.id] = { mode: 'manual', open: 1.0 };
    GEO.DRAIN_GATES.forEach(function (g) { plan.gates[g.id] = { mode: 'auto', open: 1.0 }; });
    GEO.BASINS.forEach(function (d) { plan.gates[d.gate] = { mode: 'manual', open: 0.0 }; });
    GEO.PUMPS.forEach(function (p) { plan.pumps[p.id] = { on: false, units: 0 }; });
    return plan;
  }

  // 存在隐患的基准方案：挡潮闸全程敞开、低洼片自排闸锁定开启、仅两台泵在线、北湖过早分洪
  function baselinePlan() {
    var p = defaultPlan();
    p.pumps.p2 = { on: true, units: 3 };
    p.pumps.p7 = { on: true, units: 3 };
    p.gates.g2 = { mode: 'manual', open: 1.0 };
    p.gates.g7 = { mode: 'manual', open: 1.0 };
    p.gates.g1 = { mode: 'manual', open: 0.6 };
    p.gates.D2 = { mode: 'manual', open: 0.8, startH: 6, endH: null };
    p.gates.D1 = { mode: 'manual', open: 0.0 };
    p.diversions = [{ basin: 'd2', startH: 6, open: 0.8 }];
    return p;
  }

  function gateOpenAt(plan, gateId, h, levels) {
    var ctl = plan.gates[gateId];
    if (!ctl) return 0;
    var open = ctl.mode === 'manual' ? (ctl.open || 0) : ctl.open;
    if (gateId === GEO.TIDE_GATE.id) {
      if (ctl.mode === 'auto') {
        // 潮位高于内河时自动落闸
        return levels.sea >= levels.rivers.r1 - 0.05 ? 0 : (ctl.open == null ? 1 : ctl.open);
      }
      // 手动挡潮闸支持分时启闭
      if (ctl.periods) {
        for (var i = 0; i < ctl.periods.length; i++) {
          var pe = ctl.periods[i];
          if (h >= pe.from && h < pe.to) return pe.open;
        }
        return ctl.open == null ? 1 : ctl.open;
      }
      return open;
    }
    var g = GEO.byId[gateId];
    if (g && g.block) {
      if (ctl.mode === 'auto') {
        var blv = levels.blocks[g.block];
        var rlv = levels.rivers[g.river];
        if (blv <= rlv - 0.03) return 0; // 防倒灌自动关闸
        return ctl.open == null ? 1 : ctl.open;
      }
    }
    if (g && g.river && GEO.byId[gateId] && GEO.BASINS.some(function (d) { return d.gate === gateId; })) {
      if (ctl.startH != null && h < ctl.startH) return 0;
      if (ctl.endH != null && h >= ctl.endH) return 0;
    }
    return open;
  }

  function initState(st) {
    var v = { blocks: {}, rivers: {}, basins: {} };
    Object.keys(st.blocks).forEach(function (id) { v.blocks[id] = 0; });
    v.rivers.r1 = CORE.riverVolAt(st, 'r1', 0.3);
    v.rivers.r2 = CORE.riverVolAt(st, 'r2', 0.25);
    GEO.BASINS.forEach(function (d) { v.basins[d.id] = CORE.basinVolAt(st, d.id, d.bed + 0.2); });
    return v;
  }

  global.SIM_ENGINE_PART1 = {
    clonePlan: clonePlan, defaultPlan: defaultPlan, baselinePlan: baselinePlan,
    gateOpenAt: gateOpenAt, initState: initState
  };
})(typeof window !== 'undefined' ? window : globalThis);
