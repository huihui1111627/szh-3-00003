/* 单子步积分：闸门孔流 + 泵站抽水 + 产汇流入河/分洪
   交换流量按“两节点水位拉平”上限截断，避免小当量河道子步振荡 */
(function (global) {
  'use strict';
  var GEO = global.GEO, CORE = global.SIM_CORE, E1 = global.SIM_ENGINE_PART1;

  function cappedQ(q, aHi, aLo, dh, secs) {
    if (q <= 0 || dh <= 0) return 0;
    var share = aLo === Infinity ? 1 : aLo / (aHi + aLo); // 无限大下游 → 源节点全部水量可流出
    var eq = aHi * dh * share / secs;
    return Math.min(q, eq);
  }

  function integrate(geo, st, plan, h, sea, in1, in2, sc, SUB, dtH, v, stats, step) {
    var warm = stats == null;
    var dts = dtH / SUB;
    var secs = dtH * 3600 / SUB;
    var drainFlow = {}, divFlow = {};
    var g0Sum = 0, pumpVolStep = 0, overflowByBasin = {};
    geo.BASINS.forEach(function (d) { divFlow[d.id] = 0; overflowByBasin[d.id] = 0; });
    geo.DRAIN_GATES.forEach(function (g) { drainFlow[g.id] = 0; });

    for (var k = 0; k < SUB; k++) {
      var lv = global.SIM_RUN.levelsOf(st, v, sea);
      var openG0 = E1.gateOpenAt(plan, 'G0', h, lv);

      // 产流：降雨 × 径流系数0.85（mm/h → m³/子步）
      geo.BLOCKS.forEach(function (b) {
        var mm = geo.rainAt(b.id, h, sc);
        v.blocks[b.id] += mm / 1000 * 0.85 * st.blocks[b.id].area * secs / 3600;
      });

      // 上游来水
      v.rivers.r1 += in1 * secs;
      v.rivers.r2 += in2 * secs;

      // 支河汇入主河
      var a1 = st.rivers.r1.area, a2 = st.rivers.r2.area;
      var jHi = lv.rivers.r2 >= lv.rivers.r1 ? a2 : a1;
      var jLo = lv.rivers.r2 >= lv.rivers.r1 ? a1 : a2;
      var jq = CORE.orificeQ(geo.RIVER_JOIN.qMax, 1, Math.max(lv.rivers.r2, lv.rivers.r1), Math.min(lv.rivers.r2, lv.rivers.r1));
      jq = cappedQ(jq, jHi, jLo, Math.abs(lv.rivers.r2 - lv.rivers.r1), secs);
      var jVol = jq * secs;
      if (lv.rivers.r2 >= lv.rivers.r1) { v.rivers.r2 -= jVol; v.rivers.r1 += jVol; }
      else { v.rivers.r1 -= jVol; v.rivers.r2 += jVol; }

      // 挡潮闸：主河口 ↔ 外海（外海当量取很大）
      var qg0Raw = lv.rivers.r1 > lv.sea
        ? CORE.orificeQ(geo.TIDE_GATE.qMax, openG0, lv.rivers.r1, lv.sea)
        : -CORE.orificeQ(geo.TIDE_GATE.qMax, openG0, lv.sea, lv.rivers.r1);
      var seaEqA = Infinity;
      qg0Raw = qg0Raw > 0
        ? cappedQ(qg0Raw, a1, seaEqA, lv.rivers.r1 - lv.sea, secs)
        : -cappedQ(-qg0Raw, a1, seaEqA, lv.sea - lv.rivers.r1, secs);
      v.rivers.r1 -= qg0Raw * secs;
      g0Sum += qg0Raw / SUB;

      // 街区自排闸：街区 ↔ 河道（正：街区排入河）
      geo.DRAIN_GATES.forEach(function (g) {
        var open = E1.gateOpenAt(plan, g.id, h, lv);
        var blv = lv.blocks[g.block], rlv = lv.rivers[g.river];
        var aB = st.blocks[g.block].area, aR = st.rivers[g.river].area;
        var q = 0;
        if (blv > rlv) q = cappedQ(CORE.orificeQ(g.qMax, open, blv, rlv), aB, aR, blv - rlv, secs);
        else q = -cappedQ(CORE.orificeQ(g.qMax, open, rlv, blv), aR, aB, rlv - blv, secs);
        var vol = q * secs;
        var nb = v.blocks[g.block] - vol;
        if (nb < 0 && q > 0) { vol -= -nb; v.blocks[g.block] = 0; } else v.blocks[g.block] = nb;
        v.rivers[g.river] += vol;
        drainFlow[g.id] += q / SUB;
      });

      // 泵站：街区 → 河道；高背压折减；需求负荷用于过载判定
      geo.PUMPS.forEach(function (p) {
        var ctl = plan.pumps[p.id];
        if (ctl.on && ctl.units > 0) {
          var blv2 = lv.blocks[p.block];
          var rlv2 = lv.rivers[p.river];
          var dep = blv2 - st.blocks[p.block].gl;
          var cap = ctl.units * p.qUnit;
          var demand = dep > 0.02 ? Math.min((dep / 0.4) * cap * 1.6, cap * 2.2) : 0;
          if (rlv2 > st.blocks[p.block].gl + 1.2) cap *= 0.35;
          var delivered = Math.min(demand, cap);
          var pvol = delivered * secs;
          var nb2 = v.blocks[p.block] - pvol;
          if (nb2 < 0) { pvol += nb2; v.blocks[p.block] = 0; } else v.blocks[p.block] = nb2;
          v.rivers[p.river] += pvol;
          pumpVolStep += pvol;
          if (!warm && k === SUB - 1 && stats) stats.pumpLoad[p.id] = cap > 0 && ctl.units > 0 ? demand / (ctl.units * p.qUnit) : 0;
        } else if (!warm && k === SUB - 1 && stats) {
          stats.pumpLoad[p.id] = 0;
        }
      });

      // 分洪闸：河道 ↔ 蓄滞洪区（正：进洪）
      geo.BASINS.forEach(function (d) {
        var open = E1.gateOpenAt(plan, d.gate, h, lv);
        var rlv3 = lv.rivers[d.river], dLv = lv.basins[d.id];
        var aR2 = st.rivers[d.river].area, aD = st.basins[d.id].area;
        var qd = 0;
        if (rlv3 > dLv) qd = cappedQ(CORE.orificeQ(80, open, rlv3, dLv), aR2, aD, rlv3 - dLv, secs);
        else qd = -cappedQ(CORE.orificeQ(80, open, dLv, rlv3), aD, aR2, dLv - rlv3, secs);
        var dvol = qd * secs;
        v.rivers[d.river] -= dvol;
        v.basins[d.id] += dvol;
        var capLv = d.bed + d.capDepth;
        var curLv = CORE.basinLevel(st, d.id, v.basins[d.id]);
        if (curLv > capLv) {
          var excess = CORE.basinVolAt(st, d.id, curLv) - CORE.basinVolAt(st, d.id, capLv);
          v.basins[d.id] -= excess;
overflowByBasin[d.id] += excess;
        }
        if (v.basins[d.id] < 0) v.basins[d.id] = 0;
        divFlow[d.id] += qd / SUB;
      });

      if (v.rivers.r1 < 0) v.rivers.r1 = 0;
      if (v.rivers.r2 < 0) v.rivers.r2 = 0;
    }

    if (!warm && stats) {
      stats.g0Flow = g0Sum;
      stats.drainFlow = drainFlow;
      stats.divFlow = divFlow;
      stats.pumpVolStep = pumpVolStep;
stats.overflow = overflowByBasin;
      stats.backflowStep = g0Sum < 0 ? 1 : 0;
    }
  }

  global.SIM_INTEGRATE = integrate;
})(typeof window !== 'undefined' ? window : globalThis);
