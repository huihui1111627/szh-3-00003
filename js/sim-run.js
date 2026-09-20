/* 逐时段水量平衡：6h 热启动 + 48h 正式推演，输出序列、告警区间、指标 */
(function (global) {
  'use strict';
  var GEO = global.GEO, CORE = global.SIM_CORE, E1 = global.SIM_ENGINE_PART1;

  function levelsOf(st, v, sea) {
    var lv = { sea: sea, blocks: {}, rivers: {}, basins: {} };
    Object.keys(v.blocks).forEach(function (id) { lv.blocks[id] = CORE.blockLevel(st, id, v.blocks[id]); });
    GEO.RIVERS.forEach(function (r) { lv.rivers[r.id] = CORE.riverLevel(st, r.id, v.rivers[r.id]); });
    GEO.BASINS.forEach(function (d) { lv.basins[d.id] = CORE.basinLevel(st, d.id, v.basins[d.id]); });
    return lv;
  }

  function neutralPlan() { return E1.defaultPlan(); }

  function run(geo, scenario, plan, opts) {
    opts = opts || {};
    var integrate = global.SIM_INTEGRATE;
    var st = CORE.storage(geo);
    var N = geo.totalSteps(), SUB = CORE.SUBSTEPS, dtH = geo.DT_MIN / 60;
    var v = E1.initState(st);
    var out = [];
    var warnings = [];
    var activeWarn = {};
    var backflowVol = { g0: 0, drains: {}, diversions: {} };
    var overflowVol = {};
    geo.BASINS.forEach(function (d) { overflowVol[d.id] = 0; });
    var overloadSteps = 0, conflictSteps = 0, energyKwh = 0, totalPumpVol = 0;
    var arrivalStep = {}, maxDepth = {};
    geo.BLOCKS.forEach(function (b) { maxDepth[b.id] = 0; });
    var maxSea = -99, maxRiver = { r1: -99, r2: -99 };

    function setWarn(step, on, key, sev, kind, title, detail) {
      if (on) {
        if (!activeWarn[key]) {
          activeWarn[key] = { key: key, sev: sev, kind: kind, title: title, detail: detail, start: step, end: step };
          warnings.push(activeWarn[key]);
        } else {
          activeWarn[key].end = step;
          if (sev === 'high') activeWarn[key].sev = 'high';
        }
      } else if (activeWarn[key]) {
        activeWarn[key] = null;
      }
    }

    // 热启动 6h：中性调度，边界条件取初始量级
    var warmSteps = geo.hourToStep(6);
    for (var ws = 0; ws < warmSteps; ws++) {
      var wh = geo.stepToHour(ws);
      var wSea = geo.tideAt(0, scenario) * 0.3;
      integrate(geo, st, neutralPlan(), wh, wSea, geo.inflowAt(0, scenario, 'r1') * 0.5,
        geo.inflowAt(0, scenario, 'r2') * 0.5, scenario, SUB, dtH, v, null, null);
    }

    for (var s = 0; s < N; s++) {
      var h = geo.stepToHour(s);
      var sea = geo.tideAt(h, scenario);
      var in1 = geo.inflowAt(h, scenario, 'r1');
      var in2 = geo.inflowAt(h, scenario, 'r2');
      var stats = { pumpLoad: {} };
      integrate(geo, st, plan, h, sea, in1, in2, scenario, SUB, dtH, v, stats, s);

      var lv = levelsOf(st, v, sea);
      var openings = {}, pumpInfo = {};
      openings.G0 = E1.gateOpenAt(plan, 'G0', h, lv);
      geo.DRAIN_GATES.forEach(function (g) { openings[g.id] = E1.gateOpenAt(plan, g.id, h, lv); });
      geo.BASINS.forEach(function (d) { openings[d.gate] = E1.gateOpenAt(plan, d.gate, h, lv); });

      var anyOverload = false;
      geo.PUMPS.forEach(function (p) {
        var ctl = plan.pumps[p.id];
        var load = stats.pumpLoad[p.id] || 0;
        pumpInfo[p.id] = { load: load, units: ctl.units || 0, on: !!ctl.on };
        energyKwh += (ctl.on ? ctl.units * p.kw : 0) * dtH;
        var over = ctl.on && load > 1.02;
        if (over) anyOverload = true;
        setWarn(s, over, 'OL-' + p.id, 'high', 'overload', p.name + '过载',
          '街区来水需求达到装机能力的 ' + Math.round(load * 100) + '%，存在 ' + Math.round((load - 1) * 100) + '% 抽排缺口');
      });
      if (anyOverload) overloadSteps++;

      // 挡潮闸倒灌
      var bf0 = stats.g0Flow < -0.5;
      if (bf0) {
        backflowVol.g0 += -stats.g0Flow * 3600 * dtH;
        setWarn(s, true, 'BF-G0', 'high', 'backflow', '河口潮水倒灌',
          '潮位 ' + sea.toFixed(2) + 'm 高于主河道 ' + lv.rivers.r1.toFixed(2) + 'm，挡潮闸开度 ' + Math.round(openings.G0 * 100) + '%，海水经 G0 进港');
      } else setWarn(s, false, 'BF-G0');

      // 自排闸倒灌
      geo.DRAIN_GATES.forEach(function (g) {
        var f = stats.drainFlow[g.id];
        var on = f < -0.3;
        if (on) {
          backflowVol.drains[g.id] = (backflowVol.drains[g.id] || 0) + -f * 3600 * dtH;
          setWarn(s, true, 'BF-' + g.id, 'high', 'backflow', g.name + '河水倒灌',
            GEO.byId[g.block].name + ' 闸门开度 ' + Math.round(openings[g.id] * 100) + '%，河道水位高过街区地面');
        } else setWarn(s, false, 'BF-' + g.id);
      });

      // 分洪回流 / 漫溢
      geo.BASINS.forEach(function (d) {
        var f = stats.divFlow[d.id];
        var dLv = lv.basins[d.id], cap = d.bed + d.capDepth;
        setWarn(s, f < -0.3, 'BF-' + d.gate, 'high', 'backflow', d.name + '分洪渠回流',
          '闸后水位低于河道，开闸导致河水反向进入分洪渠');
        if (f < -0.3) backflowVol.diversions[d.id] = (backflowVol.diversions[d.id] || 0) + -f * 3600 * dtH;
        var over = dLv > cap;
        if (over) {
          overflowVol[d.id] += stats.overflow[d.id] || 0;
          setWarn(s, true, 'OV-' + d.id, 'high', 'overflow', d.name + '漫溢',
            '蓄滞水位 ' + dLv.toFixed(2) + 'm 超过堤顶 ' + cap.toFixed(2) + 'm，建议减小开度或错峰');
        } else setWarn(s, false, 'OV-' + d.id);
      });

      // C1：关闸顶托（上游大来水 + 主河超警 + 挡潮闸关闭）
      setWarn(s, openings.G0 === 0 && lv.rivers.r1 > 2.1 && in1 > 80, 'CF-C1', 'mid', 'conflict',
        '上下游冲突：关闸顶托', '挡潮闸关闭御潮，但上游来水 ' + Math.round(in1) + ' m³/s 被迫滞蓄，主河道水位 ' + lv.rivers.r1.toFixed(2) + 'm 超警');
      if (activeWarn['CF-C1']) conflictSteps++;

      // C2：多个街区在河水高于地面时仍自排
      var overStreet = geo.DRAIN_GATES.filter(function (g) {
        return openings[g.id] > 0 && lv.rivers[g.river] > st.blocks[g.block].gl + 0.02;
      });
      setWarn(s, overStreet.length >= 2, 'CF-C2', 'mid', 'conflict', '上下游冲突：高位自排',
        overStreet.map(function (g) { return GEO.byId[g.block].name; }).join('、') + ' 自排闸仍开，河水已高过地面，应改自排为强排');
      if (activeWarn['CF-C2']) conflictSteps++;

      // C3：分洪顺序冲突（高水位、库容将满、进洪效率低）
      geo.BASINS.forEach(function (d) {
        var key = 'CF-C3-' + d.id;
        var used = (lv.basins[d.id] - d.bed) / d.capDepth;
        var on = openings[d.gate] > 0 && lv.rivers[d.river] > 1.9 && used > 0.75 && (stats.divFlow[d.id] || 0) < 6;
        setWarn(s, on, key, 'mid', 'conflict', '分洪顺序冲突：' + d.name,
          '主河高水位时进洪，库容已用 ' + Math.round(used * 100) + '%，继续进洪易回流漫溢，建议错峰或改用西郊片区');
        if (activeWarn[key]) conflictSteps++;
      });

      var depths = {};
      geo.BLOCKS.forEach(function (b) {
        var dep = Math.max(0, CORE.blockLevel(st, b.id, v.blocks[b.id]) - b.gl);
        depths[b.id] = dep;
        if (dep > maxDepth[b.id]) maxDepth[b.id] = dep;
        if (dep >= 0.15 && arrivalStep[b.id] == null) arrivalStep[b.id] = s;
      });
      maxSea = Math.max(maxSea, sea);
      maxRiver.r1 = Math.max(maxRiver.r1, lv.rivers.r1);
      maxRiver.r2 = Math.max(maxRiver.r2, lv.rivers.r2);
      totalPumpVol += stats.pumpVolStep || 0;

      out.push({
        step: s, h: h, sea: sea, in1: in1, in2: in2,
        rain: geo.BLOCKS.map(function (b) { return geo.rainAt(b.id, h, scenario); }),
        river: { r1: lv.rivers.r1, r2: lv.rivers.r2 },
        depths: depths,
        basin: geo.BASINS.map(function (d) { return { id: d.id, level: lv.basins[d.id], depth: lv.basins[d.id] - d.bed, cap: d.capDepth }; }),
        openings: openings, pumps: pumpInfo,
        flows: { g0: stats.g0Flow, drain: stats.drainFlow, div: stats.divFlow }
      });
    }

    return {
      N: N, series: out, warnings: warnings.filter(Boolean),
      metrics: buildMetrics(geo, {
        maxDepth: maxDepth, arrivalStep: arrivalStep, maxSea: maxSea, maxRiver: maxRiver,
        backflowVol: backflowVol, overflowVol: overflowVol,
        overloadSteps: overloadSteps, conflictSteps: conflictSteps,
        energyKwh: energyKwh, totalPumpVol: totalPumpVol
      })
    };
  }

  function buildMetrics(geo, m) {
    var worst = 0, floodedArea = 0, arr = [];
    geo.BLOCKS.forEach(function (b) {
      var d = m.maxDepth[b.id];
      worst = Math.max(worst, d);
      if (d >= 0.15) floodedArea += b.area * Math.min(1, d / 0.8);
      if (m.arrivalStep[b.id] != null) arr.push(geo.stepToHour(m.arrivalStep[b.id]));
    });
    var backSum = m.backflowVol.g0; // 挡潮闸倒灌净量
    Object.keys(m.backflowVol.drains).forEach(function (k) { backSum += m.backflowVol.drains[k]; }); // 河水入街区净量
    var overSum = 0;
    Object.keys(m.overflowVol).forEach(function (k) { overSum += m.overflowVol[k]; });
    return {
      worstDepth: worst,
      floodedAreaHa: floodedArea,
      earliestArrivalH: arr.length ? Math.min.apply(null, arr) : null,
      maxSea: m.maxSea, maxRiverR1: m.maxRiver.r1, maxRiverR2: m.maxRiver.r2,
      backflowVol: backSum, overflowVol: overSum,
      overloadSteps: m.overloadSteps, conflictSteps: m.conflictSteps,
      energyKwh: m.energyKwh
    };
  }

  global.SIM_RUN = { run: run, levelsOf: levelsOf };
})(typeof window !== 'undefined' ? window : globalThis);
