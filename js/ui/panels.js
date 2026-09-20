/* 面板渲染：方案列表、工程调度控件、告警对策、街区指标、方案比较 */
(function (global) {
  'use strict';
  var GEO = global.GEO;

  function el(html) {
    var d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstChild;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function f1(v) { return v == null || isNaN(v) ? '—' : (Math.round(v * 10) / 10).toFixed(1); }
  function f2(v) { return v == null || isNaN(v) ? '—' : (Math.round(v * 100) / 100).toFixed(2); }

  // —— 方案列表 ——
  function renderSchemeList(container, schemes, activeId, compareIds, handlers) {
    container.innerHTML = '';
    schemes.forEach(function (scm) {
      var m = scm.result.metrics;
      var score = scm.score != null ? Math.round(scm.score) : '—';
      var inCmp = compareIds.indexOf(scm.id) >= 0;
      var item = el(
        '<div class="scheme-item ' + (scm.id === activeId ? 'active' : '') + ' ' + (scm.locked ? 'locked' : '') + '" data-id="' + scm.id + '">' +
          '<div class="si-top"><span class="si-name">' + esc(scm.name) + '</span>' +
          '<span class="si-score">评分 ' + score + '</span></div>' +
          '<div class="si-meta">最大淹深 ' + f2(m.worstDepth) + 'm · 淹没 ' + f1(m.floodedAreaHa) + 'ha · 能耗 ' + f1(m.energyKwh) + 'kWh</div>' +
          '<div class="si-btns">' +
            '<button class="ghost small act-open">打开</button>' +
            '<button class="ghost small act-cmp">' + (inCmp ? '移出对比' : '加入对比') + '</button>' +
            (scm.locked ? '' : '<button class="ghost small act-del">删除</button>') +
          '</div>' +
        '</div>');
      item.addEventListener('click', function (e) {
        if (e.target.classList.contains('act-cmp')) handlers.toggleCompare(scm.id);
        else if (e.target.classList.contains('act-del')) handlers.remove(scm.id);
        else handlers.open(scm.id);
      });
      container.appendChild(item);
    });
  }

  // —— 工程调度控件 ——
  function renderControls(state, scheme, onChange) {
    document.getElementById('ctlSchemeName').textContent = scheme.locked ? scheme.name + '（只读）' : scheme.name;
    var readOnly = !!scheme.locked;
    var plan = scheme.plan;

    var g0 = plan.gates.G0;
    document.getElementById('g0Ctl').innerHTML = '';
    var g0Box = el(
      '<div class="gate-row"><div class="gr-top"><span class="gr-name">G0 河口挡潮闸</span>' +
      '<span class="seg"><button data-m="auto">自动(潮位)</button><button data-m="manual">手动</button></span></div>' +
      '<div class="range-row"><span>开度</span><input type="range" min="0" max="100" value="' + Math.round((g0.open == null ? 1 : g0.open) * 100) + '" ' + (readOnly ? 'disabled' : '') + '><span class="range-val">' + Math.round((g0.open == null ? 1 : g0.open) * 100) + '%</span></div>' +
      '<div class="hint" style="margin:4px 0 0">自动模式：潮位 ≥ 内河水位时自动落闸御潮。手动模式为全程固定开度。</div></div>');
    g0Box.querySelectorAll('.seg button').forEach(function (b) {
      if (b.dataset.m === g0.mode) b.classList.add('on');
      b.disabled = readOnly;
      b.addEventListener('click', function () {
        g0.mode = b.dataset.m;
        if (g0.mode === 'auto') delete g0.periods;
        onChange();
      });
    });
    var rng = g0Box.querySelector('input[type=range]');
    rng.addEventListener('input', function () {
      g0.mode = 'manual'; g0.open = rng.value / 100; delete g0.periods;
      g0Box.querySelector('.range-val').textContent = rng.value + '%';
      onChange();
    });
    document.getElementById('g0Ctl').appendChild(g0Box);

    var gd = document.getElementById('gDrainCtl'); gd.innerHTML = '';
    GEO.DRAIN_GATES.forEach(function (g) {
      var ctl = plan.gates[g.id];
      var b = GEO.byId[g.block];
      var row = el(
        '<div class="gate-row"><div class="gr-top"><span class="gr-name">' + g.id + ' ' + g.name + '<small style="color:#6b86a0">（' + b.name + '）</small></span>' +
        '<span class="seg"><button data-m="auto">防倒灌</button><button data-m="manual">手动</button></span></div>' +
        '<div class="range-row"><span>开度</span><input type="range" min="0" max="100" value="' + Math.round((ctl.open == null ? 1 : ctl.open) * 100) + '" ' + (readOnly ? 'disabled' : '') + '><span class="range-val">' + Math.round((ctl.open == null ? 1 : ctl.open) * 100) + '%</span></div></div>');
      row.querySelectorAll('.seg button').forEach(function (btn) {
        if (btn.dataset.m === ctl.mode) btn.classList.add('on');
        btn.disabled = readOnly;
        btn.addEventListener('click', function () { ctl.mode = btn.dataset.m; onChange(); });
      });
      var rr = row.querySelector('input[type=range]');
      rr.addEventListener('input', function () {
        ctl.mode = 'manual'; ctl.open = rr.value / 100;
        row.querySelector('.range-val').textContent = rr.value + '%';
        onChange();
      });
      gd.appendChild(row);
    });

    var pc = document.getElementById('pumpCtl'); pc.innerHTML = '';
    GEO.PUMPS.forEach(function (p) {
      var ctl = plan.pumps[p.id];
      var btns = [];
      for (var u = 0; u <= p.units; u++) btns.push('<button data-u="' + u + '" class="' + (ctl.on && ctl.units === u ? 'on' : '') + '" ' + (readOnly ? 'disabled' : '') + '>' + u + '</button>');
      var row = el(
        '<div class="pump-row" data-pid="' + p.id + '"><div class="pr-top"><span class="pr-name">' + p.id + ' ' + p.name +
        '<small style="color:#6b86a0"> 单机' + p.qUnit + 'm³/s · ' + p.kw + 'kW</small></span>' +
        '<span class="pr-state"></span></div><div class="range-row"><span>开机台数</span><span class="seg unit-seg">' + btns.join('') + '</span></div></div>');
      row.querySelectorAll('.unit-seg button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var u2 = +btn.dataset.u;
          ctl.on = u2 > 0; ctl.units = u2; onChange();
        });
      });
      pc.appendChild(row);
    });

    var dc = document.getElementById('divCtl'); dc.innerHTML = '';
    GEO.BASINS.forEach(function (basin) {
      var ctl = plan.gates[basin.gate];
      var row = el(
        '<div class="div-row"><div class="dr-top"><span class="dr-name">' + basin.gate + ' ' + basin.name + ' 分洪闸</span>' +
        '<span class="dr-state"></span></div>' +
        '<div class="range-row"><span>开度</span><input type="range" min="0" max="100" value="' + Math.round((ctl.open || 0) * 100) + '" ' + (readOnly ? 'disabled' : '') + '><span class="range-val">' + Math.round((ctl.open || 0) * 100) + '%</span></div>' +
        '<div class="range-row"><span>进洪</span><input class="time-inp startH" type="number" min="0" max="48" step="1" value="' + (ctl.startH == null ? '' : ctl.startH) + '" placeholder="起h" ' + (readOnly ? 'disabled' : '') + '><span>时起 至</span>' +
        '<input class="time-inp endH" type="number" min="0" max="48" step="1" value="' + (ctl.endH == null ? '' : ctl.endH) + '" placeholder="终h" ' + (readOnly ? 'disabled' : '') + '><span>时（空=持续）</span></div></div>');
      var r1 = row.querySelectorAll('input[type=range]')[0];
      r1.addEventListener('input', function () {
        ctl.open = r1.value / 100; row.querySelector('.range-val').textContent = r1.value + '%'; onChange();
      });
      row.querySelector('.startH').addEventListener('change', function (e) {
        ctl.startH = e.target.value === '' ? null : +e.target.value; onChange();
      });
      row.querySelector('.endH').addEventListener('change', function (e) {
        ctl.endH = e.target.value === '' ? null : +e.target.value; onChange();
      });
      dc.appendChild(row);
    });
  }

  function refreshPumpStates(scheme, step) {
    var f = scheme.result.series[step];
    document.querySelectorAll('.pump-row').forEach(function (row) {
      var pid = row.dataset.pid;
      var info = f.pumps[pid];
      var st = row.querySelector('.pr-state');
      st.textContent = info.on ? '负荷 ' + Math.round(info.load * 100) + '%' : '停机';
      st.style.color = info.load > 1.02 ? '#ef5d5d' : info.on ? '#4dd08b' : '#6b86a0';
      row.classList.toggle('overload', info.on && info.load > 1.02);
    });
  }

  global.PANELS_P1 = {
    el: el, esc: esc, f1: f1, f2: f2,
    renderSchemeList: renderSchemeList,
    renderControls: renderControls,
    refreshPumpStates: refreshPumpStates
  };
})(typeof window !== 'undefined' ? window : globalThis);
