/* 面板渲染（续）：告警与对策、街区指标、方案比较表 */
(function (global) {
  'use strict';
  var GEO = global.GEO, P1 = global.PANELS_P1;
  var el = P1.el, esc = P1.esc, f1 = P1.f1, f2 = P1.f2;

  var KIND_NAME = { backflow: '倒灌', overload: '过载', conflict: '方案冲突', overflow: '漫溢' };

  function renderAlerts(container, scheme, rec, onApply) {
    container.innerHTML = '';
    var warns = scheme.result.warnings.slice().sort(function (a, b) {
      if (a.sev !== b.sev) return a.sev === 'high' ? -1 : 1;
      return a.start - b.start;
    });

    if (rec && rec.tips.length) {
      var th = el('<div><h3 style="margin:2px 0 8px;font-size:12px;color:#4dd08b">原因诊断与替代组合</h3></div>');
      rec.tips.forEach(function (t) {
        th.appendChild(el('<div class="tip-box"><div class="tb-act">▸ ' + esc(t.action) + '</div><div class="tb-reason">原因：' + esc(t.reason) + '</div></div>'));
      });
      container.appendChild(th);

      if (rec.alternatives && rec.alternatives.length) {
        var ah = el('<h3 style="margin:6px 0 8px;font-size:12px;color:#4dd08b">可执行替代组合（已重新推演排序）</h3>');
        container.appendChild(ah);
        rec.alternatives.forEach(function (alt, idx) {
          var m = alt.ev.result.metrics;
          var card = el(
            '<div class="alt-card ' + (idx === 0 ? 'best' : '') + '">' +
              '<div class="alt-top"><span class="alt-name">' + (idx === 0 ? '★ ' : '') + esc(alt.name) + '</span>' +
              '<span class="alt-score">' + Math.round(alt.ev.score) + '</span></div>' +
              '<div class="score-bar"><i style="width:' + alt.ev.score + '%;max-width:100%"></i></div>' +
              '<div class="alt-desc">' + esc(alt.desc) + '</div>' +
              '<div class="alt-stats">' +
                '<span>最大淹深 <b>' + f2(m.worstDepth) + 'm</b></span>' +
                '<span>淹没面积 <b>' + f1(m.floodedAreaHa) + 'ha</b></span>' +
                '<span>最早进水 <b>' + (m.earliestArrivalH == null ? '无' : GEO.fmtClock(m.earliestArrivalH)) + '</b></span>' +
                '<span>倒灌水量 <b>' + f1(m.backflowVol / 1e4) + '万m³</b></span>' +
                '<span>过载时段 <b>' + Math.round(m.overloadSteps * GEO.DT_MIN / 60 * 10) / 10 + 'h</b></span>' +
                '<span>能耗 <b>' + f1(m.energyKwh / 1000) + '千kWh</b></span>' +
              '</div>' +
              '<button class="primary small" style="width:100%">应用此组合（复制为新方案）</button>' +
            '</div>');
          card.querySelector('button').addEventListener('click', function () { onApply(alt); });
          container.appendChild(card);
        });
      }
    }

    var hd = el('<h3 style="margin:12px 0 8px;font-size:12px;color:#8aa3bb">告警时间线（' + warns.length + ' 段）</h3>');
    container.appendChild(hd);
    if (!warns.length) container.appendChild(el('<div class="hint">当前方案全程未触发倒灌、过载、漫溢或冲突告警。</div>'));
    warns.forEach(function (w) {
      var dur = (w.end - w.start) * GEO.DT_MIN / 60;
      var card = el(
        '<div class="alert-card ' + w.sev + '">' +
          '<div class="ac-title"><span><span class="ac-kind ' + w.kind + '">' + (KIND_NAME[w.kind] || w.kind) + '</span>' + esc(w.title) + '</span>' +
          '<span class="ac-time">' + GEO.fmtClock(GEO.stepToHour(w.start)) + ' +' + f1(dur) + 'h</span></div>' +
          '<div class="ac-detail">' + esc(w.detail) + '</div>' +
        '</div>');
      card.style.cursor = 'pointer';
      card.title = '点击跳转到告警开始时刻';
      card.addEventListener('click', function () { global.APP_API.jumpTo(w.start); });
      container.appendChild(card);
    });
  }

  function depthLevel(d) {
    if (d < 0.05) return { c: '#4dd08b', t: '无明显积水' };
    if (d < 0.15) return { c: '#9fd356', t: '轻度 <15cm' };
    if (d < 0.27) return { c: '#f5d042', t: '中度 15–27cm' };
    if (d < 0.45) return { c: '#f59045', t: '重度 27–45cm' };
    return { c: '#e25252', t: '极重 ≥45cm' };
  }

  function renderMetrics(container, scheme) {
    container.innerHTML = '';
    var m = scheme.result.metrics;
    var grid = el(
      '<div class="metric-grid">' +
        cell(f2(m.worstDepth) + 'm', '最大积水深') +
        cell(f1(m.floodedAreaHa) + 'ha', '加权淹没面积') +
        cell(m.earliestArrivalH == null ? '无' : GEO.fmtClock(m.earliestArrivalH), '最早进水时刻') +
        cell(f1(m.backflowVol / 1e4) + '万m³', '倒灌净水量') +
        cell(f2(m.maxSea) + 'm', '最高潮位') +
        cell(f2(m.maxRiverR1) + 'm', '主河最高水位') +
        cell(Math.round(m.overloadSteps * GEO.DT_MIN / 60 * 10) / 10 + 'h', '泵站过载历时') +
        cell(Math.round(m.conflictSteps * GEO.DT_MIN / 60 * 10) / 10 + 'h', '调度冲突历时') +
      '</div>');
    container.appendChild(grid);

    // 各街区逐块卡片（显示当前时刻 + 峰值 + 到达时间）
    var N = GEO.totalSteps();
    GEO.BLOCKS.forEach(function (b) {
      var maxD = 0, arr = null;
      for (var i = 0; i < N; i++) {
        var dep = scheme.result.series[i].depths[b.id];
        if (dep > maxD) maxD = dep;
        if (dep >= 0.15 && arr == null) arr = GEO.stepToHour(i);
      }
      var lv = depthLevel(maxD);
      var row = el(
        '<div class="mblock"><div class="mb-top"><span>' + b.id + ' ' + esc(b.name) + '</span><span style="color:' + lv.c + '">' + lv.t + '</span></div>' +
          '<div class="mb-row"><span>地面高程 <b>' + b.gl.toFixed(1) + 'm</b></span><span>面积 <b>' + b.area + 'ha</b></span>' +
          '<span>峰值淹深 <b>' + f2(maxD) + 'm</b></span><span>到达时刻 <b>' + (arr == null ? '—' : GEO.fmtClock(arr)) + '</b></span></div>' +
          '<div class="depthbar"><i style="width:' + Math.min(100, maxD / 0.6 * 100) + '%;background:' + lv.c + '"></i></div></div>');
      container.appendChild(row);
    });
  }

  function cell(v, k) {
    return '<div class="metric-cell"><div class="mc-v">' + v + '</div><div class="mc-k">' + k + '</div></div>';
  }

  function renderCompare(container, schemes, cmpIds, activeId, handlers) {
    container.innerHTML = '';
    var list = schemes.filter(function (s) { return cmpIds.indexOf(s.id) >= 0; });
    if (list.length < 2) {
      container.appendChild(el('<div class="hint">在左侧“调度方案”中把 2 套及以上方案“加入对比”，即可同屏同步回放并逐项比较。</div>'));
      list.forEach(function () {});
      // 仍提供勾选列表
      schemes.forEach(function (scm) {
        var row = el('<label class="cmp-toggle"><input type="checkbox" ' + (cmpIds.indexOf(scm.id) >= 0 ? 'checked' : '') + '><span>' + esc(scm.name) + '（评分 ' + Math.round(scm.score || 0) + '）</span></label>');
        row.querySelector('input').addEventListener('change', function () { handlers.toggleCompare(scm.id); });
        container.appendChild(row);
      });
      return;
    }
    var rowsDef = [
      { k: '综合评分', v: function (x) { return Math.round(x.score || 0); }, best: 'max' },
      { k: '最大积水深 m', v: function (x) { return f2(x.result.metrics.worstDepth); }, best: 'min' },
      { k: '加权淹没面积 ha', v: function (x) { return f1(x.result.metrics.floodedAreaHa); }, best: 'min' },
      { k: '最早进水时刻', v: function (x) { var h = x.result.metrics.earliestArrivalH; return h == null ? '无' : GEO.fmtClock(h); }, best: 'latest' },
      { k: '倒灌净水量 万m³', v: function (x) { return f1(x.result.metrics.backflowVol / 1e4); }, best: 'min' },
      { k: '漫溢水量 m³', v: function (x) { return f1(x.result.metrics.overflowVol); }, best: 'min' },
      { k: '最高潮位 m', v: function (x) { return f2(x.result.metrics.maxSea); }, best: null },
      { k: '主河最高水位 m', v: function (x) { return f2(x.result.metrics.maxRiverR1); }, best: 'min' },
      { k: '过载历时 h', v: function (x) { return f1(x.result.metrics.overloadSteps * GEO.DT_MIN / 60); }, best: 'min' },
      { k: '冲突历时 h', v: function (x) { return f1(x.result.metrics.conflictSteps * GEO.DT_MIN / 60); }, best: 'min' },
      { k: '能耗 千kWh', v: function (x) { return f1(x.result.metrics.energyKwh / 1000); }, best: 'min' },
      { k: '告警段数', v: function (x) { return x.result.warnings.length; }, best: 'min' }
    ];
    var wrap = document.createElement('div');
    var head = el('<div class="cmp-row" style="--n:' + list.length + '"><div class="cmp-k">指标</div>' +
      list.map(function (s) { return '<div class="' + (s.id === activeId ? 'cmp-best' : '') + '">' + esc(s.name) + '</div>'; }).join('') + '</div>');
    wrap.appendChild(head);
    rowsDef.forEach(function (rd) {
      var vals = list.map(rd.v);
      var bestIdx = -1;
      if (rd.best) {
        var hours = list.map(function (x) { var h = x.result.metrics.earliestArrivalH; return h == null ? 999 : h; });
        if (rd.best === 'latest') { bestIdx = hours.indexOf(Math.max.apply(null, hours)); }
        else {
          var nums = vals.map(function (v) { return parseFloat(v); });
          var bv = rd.best === 'max' ? Math.max.apply(null, nums) : Math.min.apply(null, nums);
          bestIdx = nums.indexOf(bv);
        }
      }
      var html = '<div class="cmp-row" style="--n:' + list.length + '"><div class="cmp-k">' + rd.k + '</div>' +
        vals.map(function (v, i) { return '<div class="' + (i === bestIdx ? 'cmp-best' : '') + '">' + v + '</div>'; }).join('') + '</div>';
      wrap.appendChild(el(html));
    });
    container.appendChild(wrap);

    var tip = el('<p class="hint" style="margin-top:8px">已加入对比的方案在地图区同屏显示，时间轴拖动/播放对所有方案同步生效。绿色为该行最优。</p>');
    container.appendChild(tip);
  }

  global.PANELS = {
    renderAlerts: renderAlerts,
    renderMetrics: renderMetrics,
    renderCompare: renderCompare
  };
})(typeof window !== 'undefined' ? window : globalThis);
