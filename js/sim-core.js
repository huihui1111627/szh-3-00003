/* 水动力推演引擎（概念模型，非工程设计依据）：
   节点：河道 r1/r2、街区、蓄滞洪区、外海；连线：自排闸孔流、挡潮闸、泵站抽水、分洪渠 */
(function (global) {
  'use strict';

  var G = global.GEO || (typeof require !== 'undefined' ? require('./geo') : null);

  function storage(geo) {
    var s = { blocks: {}, rivers: {}, basins: {} };
    geo.BLOCKS.forEach(function (b) {
      s.blocks[b.id] = { area: b.area * 10000, gl: b.gl };
    });
    geo.RIVERS.forEach(function (r) {
      var len = 0;
      for (var i = 1; i < r.path.length; i++) {
        var dx = r.path[i][0] - r.path[i - 1][0];
        var dy = r.path[i][1] - r.path[i - 1][1];
        len += Math.sqrt(dx * dx + dy * dy);
      }
      s.rivers[r.id] = { width: r.width, len: len, bed: -1.2, area: r.width * len };
    });
    geo.BASINS.forEach(function (d) {
      s.basins[d.id] = { area: d.area * 10000, bed: d.bed, capDepth: d.capDepth };
    });
    return s;
  }

  function blockLevel(st, id, v) { return st.blocks[id].gl + v / st.blocks[id].area; }
  function blockVolAt(st, id, lv) { return Math.max(0, lv - st.blocks[id].gl) * st.blocks[id].area; }
  function riverLevel(st, id, v) { var p = st.rivers[id]; return p.bed + v / p.area; }
  function riverVolAt(st, id, lv) { var p = st.rivers[id]; return Math.max(0, lv - p.bed) * p.area; }
  function basinLevel(st, id, v) { var p = st.basins[id]; return p.bed + v / p.area; }
  function basinVolAt(st, id, lv) { var p = st.basins[id]; return Math.max(0, lv - p.bed) * p.area; }

  // 孔流/堰流简化：q = open * qMax * sqrt(|dh|)，方向由水位高者指向低者
  function orificeQ(qMax, open, hi, lo) {
    if (open <= 0 || hi <= lo) return 0;
    return open * qMax * Math.sqrt(Math.max(0, hi - lo));
  }

  var SUBSTEPS = 6;

  global.SIM_CORE = {
    storage: storage,
    blockLevel: blockLevel, blockVolAt: blockVolAt,
    riverLevel: riverLevel, riverVolAt: riverVolAt,
    basinLevel: basinLevel, basinVolAt: basinVolAt,
    orificeQ: orificeQ,
    SUBSTEPS: SUBSTEPS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SIM_CORE;
  if (typeof require !== 'undefined' && typeof global.GEO === 'undefined') { try { global.GEO = require('./geo.js'); } catch (e) {} }
})(typeof window !== 'undefined' ? window : globalThis);
