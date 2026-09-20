/* 地理与工程设施数据层：街区、河道、泵站、闸门、蓄滞洪区、情景参数 */
(function (global) {
  'use strict';

  var DT_MIN = 6; // 水动力步长（分钟）
  var HOURS = 48;
  var START_ISO = '2026-09-21T00:00:00+08:00';

  var BLOCKS = [
    // id, 名称, 多边形坐标, 地面高程m, 面积ha, 泵站, 自排闸, 降雨分区系数
    { id: 'b5', name: '北港新区', poly: [[80, 70], [330, 70], [330, 180], [80, 180]], gl: 2.6, area: 130, pump: 'p4', gate: 'g4', rainZone: 0.95 },
    { id: 'b1', name: '临江里', poly: [[440, 70], [690, 70], [690, 180], [440, 180]], gl: 2.4, area: 110, pump: 'p1', gate: 'g1', rainZone: 1.05 },
    { id: 'b3', name: '城西老城区', poly: [[80, 200], [300, 200], [300, 330], [80, 330]], gl: 2.0, area: 95, pump: 'p3', gate: 'g3', rainZone: 1.1 },
    { id: 'b4', name: '西门工业区', poly: [[80, 350], [280, 350], [280, 470], [80, 470]], gl: 1.8, area: 85, pump: 'p6', gate: 'g6', rainZone: 0.9 },
    { id: 'b6', name: '火车东站', poly: [[370, 220], [690, 220], [690, 330], [370, 330]], gl: 2.7, area: 105, pump: 'p5', gate: null, rainZone: 0.8 },
    { id: 'b7', name: '南湖商住区', poly: [[370, 350], [690, 350], [690, 470], [370, 470]], gl: 1.6, area: 120, pump: 'p7', gate: 'g7', rainZone: 1.15 },
    { id: 'b2', name: '河口低洼片', poly: [[370, 500], [690, 500], [690, 610], [370, 610]], gl: 1.3, area: 90, pump: 'p2', gate: 'g2', rainZone: 1.2 }
  ];

  // 河道：多段折线串联成单河段，stage-volume 当量
  var RIVERS = [
    {
      id: 'r1', name: '东港河主河道', width: 26, n: 0.05,
      path: [[345, 60], [345, 190], [338, 330], [330, 470], [350, 620], [430, 665]]
    },
    {
      id: 'r2', name: '城西支河', width: 18, n: 0.055,
      path: [[40, 270], [180, 270], [338, 270]] // 在 (338,270) 汇入主河
    }
  ];
  var RIVER_JOIN = { up: 'r2', down: 'r1', atStep: 20, qMax: 90 }; // 支河汇入口固定过流能力

  // 蓄滞洪区
  var BASINS = [
    { id: 'd1', name: '西郊蓄滞洪区', rect: [20, 480, 200, 130], bed: 0.4, area: 260, capDepth: 3.0, gate: 'D1',
      canal: [[220, 520], [280, 430], [330, 400]], gateXY: [312, 412], river: 'r1' },
    { id: 'd2', name: '北湖分洪区', rect: [120, 0, 150, 56], bed: 0.6, area: 180, capDepth: 2.8, gate: 'D2',
      canal: [[260, 40], [300, 55], [340, 62]], gateXY: [322, 58], river: 'r1' }
  ];

  // 河口挡潮闸
  var TIDE_GATE = { id: 'G0', name: '河口挡潮闸', river: 'r1', xy: [430, 660], qMax: 320 };

  // 自排闸（街区自流排入河道）
  var DRAIN_GATES = [
    { id: 'g1', name: '临江里自排闸', block: 'b1', river: 'r1', xy: [430, 140], qMax: 36 },
    { id: 'g2', name: '河口片自排闸', block: 'b2', river: 'r1', xy: [362, 545], qMax: 30 },
    { id: 'g3', name: '老城自排闸', block: 'b3', river: 'r2', xy: [225, 282], qMax: 28 },
    { id: 'g4', name: '北港自排闸', block: 'b5', river: 'r1', xy: [358, 120], qMax: 34 },
    { id: 'g6', name: '西门自排闸', block: 'b4', river: 'r1', xy: [318, 430], qMax: 26 },
    { id: 'g7', name: '南湖自排闸', block: 'b7', river: 'r1', xy: [362, 410], qMax: 32 }
  ];

  // 泵站：机组数、单机流量m3/s、额定功率kW
  var PUMPS = [
    { id: 'p1', name: '临江泵站', block: 'b1', river: 'r1', xy: [448, 175], units: 3, qUnit: 9, kw: 320 },
    { id: 'p2', name: '河口泵站', block: 'b2', river: 'r1', xy: [372, 600], units: 3, qUnit: 7, kw: 260 },
    { id: 'p3', name: '老城泵站', block: 'b3', river: 'r2', xy: [292, 320], units: 2, qUnit: 8, kw: 300 },
    { id: 'p4', name: '北港泵站', block: 'b5', river: 'r1', xy: [356, 175], units: 3, qUnit: 10, kw: 360 },
    { id: 'p5', name: '东站泵站', block: 'b6', river: 'r1', xy: [382, 235], units: 2, qUnit: 8, kw: 290 },
    { id: 'p6', name: '西门泵站', block: 'b4', river: 'r1', xy: [292, 462], units: 2, qUnit: 6, kw: 230 },
    { id: 'p7', name: '南湖泵站', block: 'b7', river: 'r1', xy: [382, 462], units: 3, qUnit: 9, kw: 330 }
  ];

  // 情景（边界条件）：潮位、风暴潮增水、两场暴雨、上游来水
  var SCENARIOS = {
    s2: {
      id: 's2', name: '风暴潮叠加暴雨（高风险）',
      m2: { amp: 1.7, mean: 0.1, phaseH: 3.0 }, // 天文潮：高潮出现在 3:00、15:30 附近
      surge: { peakH: 15, amp: 0.9, widthH: 9 },
      rain: [
        { cH: 11, amp: 34, widthH: 3.5, zones: { b2: 1.25, b7: 1.2, b3: 1.15, b1: 1.1, b4: 1.0, b5: 1.0, b6: 0.9 } },
        { cH: 23, amp: 46, widthH: 4, zones: { b2: 1.3, b7: 1.25, b3: 1.2, b1: 1.15, b4: 1.05, b5: 1.0, b6: 0.85 } }
      ],
      in1: { peakH: 16, amp: 95, base: 22, widthH: 8 },
      in2: { peakH: 14, amp: 40, base: 10, widthH: 7 }
    },
    s1: {
      id: 's1', name: '常规大潮强降雨',
      m2: { amp: 1.35, mean: 0.0, phaseH: 3.0 },
      surge: { peakH: 15, amp: 0.25, widthH: 9 },
      rain: [
        { cH: 11, amp: 24, widthH: 3.5, zones: {} },
        { cH: 23, amp: 32, widthH: 4, zones: {} }
      ],
      in1: { peakH: 16, amp: 60, base: 18, widthH: 8 },
      in2: { peakH: 14, amp: 25, base: 8, widthH: 7 }
    }
  };

  function gaussian(h, c, w) {
    var x = (h - c) / w;
    return Math.exp(-0.5 * x * x);
  }

  function totalSteps() { return Math.round(HOURS * 60 / DT_MIN); }
  function stepToHour(step) { return step * DT_MIN / 60; }
  function hourToStep(h) { return Math.round(h * 60 / DT_MIN); }

  function tideAt(hour, sc) {
    var m = sc.m2;
    var m2 = m.amp * Math.cos(2 * Math.PI * (hour - m.phaseH) / 12.42);
    var surge = sc.surge.amp * gaussian(hour, sc.surge.peakH, sc.surge.widthH);
    return m.mean + m2 + surge;
  }

  function rainAt(blockId, hour, sc) {
    var v = 0;
    for (var i = 0; i < sc.rain.length; i++) {
      var r = sc.rain[i];
      var zf = r.zones[blockId] != null ? r.zones[blockId] : 1;
      v += r.amp * zf * gaussian(hour, r.cH, r.widthH);
    }
    return v; // mm/h
  }

  function inflowAt(hour, sc, riverId) {
    var p = riverId === 'r2' ? sc.in2 : sc.in1;
    return p.base + p.amp * gaussian(hour, p.peakH, p.widthH);
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtTime(hour) {
    var totalMin = Math.round(hour * 60);
    var base = new Date(START_ISO);
    var d = new Date(base.getTime() + totalMin * 60000);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function fmtClock(hour) {
    var totalMin = Math.round(hour * 60);
    var base = new Date(START_ISO);
    var d = new Date(base.getTime() + totalMin * 60000);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  var byId = {};
  BLOCKS.forEach(function (b) { byId[b.id] = b; });
  RIVERS.forEach(function (r) { byId[r.id] = r; });
  BASINS.forEach(function (d) { byId[d.id] = d; });
  PUMPS.forEach(function (p) { byId[p.id] = p; });
  DRAIN_GATES.forEach(function (g) { byId[g.id] = g; });
  byId[TIDE_GATE.id] = TIDE_GATE;

  var GEO = {
    DT_MIN: DT_MIN, HOURS: HOURS, START_ISO: START_ISO,
    BLOCKS: BLOCKS, RIVERS: RIVERS, RIVER_JOIN: RIVER_JOIN,
    BASINS: BASINS, TIDE_GATE: TIDE_GATE, DRAIN_GATES: DRAIN_GATES, PUMPS: PUMPS,
    SCENARIOS: SCENARIOS, byId: byId,
    totalSteps: totalSteps, stepToHour: stepToHour, hourToStep: hourToStep,
    tideAt: tideAt, rainAt: rainAt, inflowAt: inflowAt,
    fmtTime: fmtTime, fmtClock: fmtClock
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = GEO;
  global.GEO = GEO;
})(typeof window !== 'undefined' ? window : globalThis);
