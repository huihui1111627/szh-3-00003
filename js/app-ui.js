/* UI 主控：渲染循环、时间轴、控件事件、对比模式、tooltip、断点恢复 */
(function (global) {
  'use strict';
  var GEO = global.GEO;

  var mapCanvas, chartCanvas, tlCanvas;
  var curveMode = 'hydro';
  var playing = false, speed = 1, rafId = null, lastTick = 0;
  var frameCnt = 0;
  var toastTimer = null;

  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  function renderAll(rebuildControls) {
    var st = global.APP_STATE.getState();
    var active = global.APP_STATE.active();
    global.PANELS_P1.renderSchemeList($('schemeList'), st.schemes, st.activeId, st.compareIds, {
      open: function (id) { global.APP_STATE.openScheme(id); renderAll(true); },
      toggleCompare: function (id) { global.APP_STATE.toggleCompare(id); renderAll(false); },
      remove: function (id) { global.APP_STATE.removeScheme(id); renderAll(true); }
    });
    if (rebuildControls) global.PANELS_P1.renderControls(st, active, function () {
      global.APP_STATE.requestRecompute();
      $('tlStatus').textContent = '调整已记录，正在重新推演…';
    });
    renderRightPanels();
    drawAll();
  }

  function renderRightPanels() {
    var active = global.APP_STATE.active();
    var rec = global.APP_STATE.getAdvisor();
    global.PANELS.renderAlerts($('tabAlerts'), active, rec, function (alt) {
      var scm = global.APP_STATE.addPreset(alt);
      toast('已应用「' + alt.name + '」并复制为新方案');
      renderAll(true);
    });
    global.PANELS.renderMetrics($('tabMetrics'), active);
    global.PANELS.renderCompare($('tabCompare'), global.APP_STATE.getState().schemes,
      global.APP_STATE.getState().compareIds, active.id, {
        toggleCompare: function (id) { global.APP_STATE.toggleCompare(id); renderAll(false); }
      });
  }

  function onRecomputed() {
    renderRightPanels();
    drawAll();
    $('tlStatus').textContent = '已重新推演：淹深、到达时间与对策已更新';
  }

  function drawAll() {
    var st = global.APP_STATE.getState();
    var cmpList = st.schemes.filter(function (s) { return st.compareIds.indexOf(s.id) >= 0; });
    frameCnt++;

    if (cmpList.length >= 2) {
      drawCompareMaps(cmpList, st.step);
      var runs = cmpList.map(function (s) { return s.result; });
      curveDraw(runs, st.step);
    } else {
      var scm = global.APP_STATE.active();
      global.MAP.drawFrame(mapCanvas, scm.result, st.step, { frame: frameCnt });
      curveDraw([scm.result], st.step);
    }
    global.PANELS_P1.refreshPumpStates(global.APP_STATE.active(), st.step);
    var f = global.APP_STATE.active().result.series[st.step];
    $('clock').textContent = GEO.fmtTime(f.h);
    var x2m = global.CHARTS.drawTimeline(tlCanvas, global.APP_STATE.active().result, st.step);
    tlCanvas._toStep = x2m;
  }

  function curveDraw(runs, step) {
    if (curveMode === 'hydro') global.CHARTS.drawHydro(chartCanvas, runs, step);
    else global.CHARTS.drawEng(chartCanvas, runs, step);
  }

  function drawCompareMaps(list, step) {
    var d = global.CHARTS.setup(mapCanvas), ctx = mapCanvas.getContext("2d");
    ctx.clearRect(0, 0, d.w, d.h);
    var n = list.length;
    var gap = 8;
    var w = (d.w - gap * (n + 1)) / n;
    var h = d.h;
    // 缩略绘制：离屏 canvas 缩放
    var off = global.APP_UI.offscreen || (global.APP_UI.offscreen = document.createElement('canvas'));
    off.width = 760; off.height = 700;
    list.forEach(function (scm, i) {
      global.MAP.drawFrame(off, scm.result, step, { frame: frameCnt, fit: 'contain' });
      var x = gap + i * (w + gap);
      var scale = Math.min(w / 760, h / 700);
      var dw = 760 * scale, dh = 700 * scale;
      ctx.drawImage(off, x, 0, dw, dh);
      ctx.fillStyle = 'rgba(10,18,28,.82)';
      var worst = scm.result.metrics.worstDepth;
      ctx.fillRect(x + 6, 6, dw - 12, 24);
      ctx.fillStyle = i === 0 ? '#4dd08b' : '#dce8f4';
      ctx.font = '12px sans-serif';
      ctx.fillText((i + 1) + '. ' + scm.name + '（评分 ' + Math.round(scm.score) + '，最大淹深 ' + worst.toFixed(2) + 'm）', x + 12, 22);
    });
  }

  function jumpTo(step) {
    var st = global.APP_STATE.getState();
    st.step = Math.max(0, Math.min(GEO.totalSteps() - 1, step));
    global.APP_STATE.persist();
    drawAll();
  }

  function setPlaying(v) {
    playing = v;
    $('btnPlay').textContent = playing ? '⏸' : '▶';
    var st = global.APP_STATE.getState();
    st.playing = playing;
    global.APP_STATE.persist();
    if (playing) { lastTick = performance.now(); loop(); }
  }

  function loop(now) {
    if (!playing) return;
    now = now || performance.now();
    var dtMs = now - lastTick; lastTick = now;
    var st = global.APP_STATE.getState();
    var stepsPerSec = speed; // 1× = 1 步/秒（6 分钟/秒）
    st.step += dtMs / 1000 * stepsPerSec;
    if (st.step >= GEO.totalSteps() - 1) { st.step = GEO.totalSteps() - 1; setPlaying(false); toast('推演已完成，可拖回任意时刻复盘'); }
    st.step = Math.floor(st.step);
    drawAll();
    if (playing) rafId = requestAnimationFrame(loop);
  }

  global.APP_UI = { drawAll: drawAll, renderAll: renderAll, jumpTo: jumpTo, toast: toast };
  global.APP_API = { jumpTo: jumpTo, onRecomputed: onRecomputed, renderAll: renderAll };

  function bindEvents() {
    mapCanvas = $('map'); chartCanvas = $('chart'); tlCanvas = $('timeline');

    // 情景
    var sel = $('scenarioSel');
    Object.keys(GEO.SCENARIOS).forEach(function (sid) {
      var o = document.createElement('option');
      o.value = sid; o.textContent = GEO.SCENARIOS[sid].name;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      global.APP_STATE.recomputeAll(sel.value);
      toast('已切换情景并重新推演全部方案');
      renderAll(true);
    });

    $('btnReset').addEventListener('click', function () {
      if (!confirm('将清空所有方案与时间轴位置，恢复为初始基准推演。确认？')) return;
      global.STORE.clear();
      global.APP_STATE.freshState(sel.value);
      advisorReset();
      renderAll(true);
      toast('推演已重置');
    });

    $('btnCopyScheme').addEventListener('click', function () {
      global.APP_STATE.copyActive();
      renderAll(true);
      toast('已复制当前方案，可自由调整闸门与泵站');
    });
    $('btnBaseScheme').addEventListener('click', function () {
      global.APP_STATE.openScheme(global.APP_STATE.getState().schemes[0].id);
      renderAll(true);
    });
    $('btnCompare').addEventListener('click', function () {
      document.querySelector('.rtab[data-tab=compare]').click();
      toast('在左侧把 2 套以上方案“加入对比”即可同屏同步回放');
    });

    // 播放
    $('btnPlay').addEventListener('click', function () { setPlaying(!playing); });
    document.querySelectorAll('.sp').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('.sp').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        speed = +b.dataset.sp;
        global.APP_STATE.getState().speed = speed;
        global.APP_STATE.persist();
      });
    });

    // 时间轴拖拽
    var dragging = false;
    function seekFromEvent(e) {
      var step = tlCanvas._toStep(e.clientX);
      jumpTo(step);
    }
    tlCanvas.addEventListener('mousedown', function (e) { dragging = true; seekFromEvent(e); });
    window.addEventListener('mousemove', function (e) { if (dragging) seekFromEvent(e); });
    window.addEventListener('mouseup', function () { dragging = false; });
    tlCanvas.addEventListener('touchstart', function (e) { dragging = true; seekFromEvent(e.touches[0]); e.preventDefault(); }, { passive: false });
    window.addEventListener('touchmove', function (e) { if (dragging) seekFromEvent(e.touches[0]); }, { passive: false });
    window.addEventListener('touchend', function () { dragging = false; });

    // 曲线点击也联动跳转
    chartCanvas.addEventListener('click', function (e) {
      var rect = chartCanvas.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var ratio = Math.max(0, Math.min(1, (x - 42) / (rect.width - 56)));
      jumpTo(Math.round(ratio * (GEO.totalSteps() - 1)));
    });

    // 曲线分页
    document.querySelectorAll('[data-curve]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-curve]').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        curveMode = b.dataset.curve;
        drawAll();
      });
    });

    // 右侧 tab
    document.querySelectorAll('.rtab').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('.rtab').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        ['alerts', 'metrics', 'compare'].forEach(function (t) {
          $('tab' + t[0].toUpperCase() + t.slice(1)).hidden = t !== b.dataset.tab;
        });
      });
    });

    // 地图 tooltip
    var tip = $('mapTip');
    mapCanvas.addEventListener('mousemove', function (e) {
      var rect = mapCanvas.getBoundingClientRect();
      var fit = global.MAP.fitScale(mapCanvas);
      var px = (e.clientX - rect.left) / fit.x, py = (e.clientY - rect.top) / fit.y;
      var hit = global.MAP.hitTest(px, py);
      if (!hit) { tip.hidden = true; return; }
      var st = global.APP_STATE.getState(), f = global.APP_STATE.active().result.series[st.step];
      var html = '';
      if (hit.type === 'block') {
        var b = GEO.byId[hit.id], dep = f.depths[hit.id];
        var arr = '—';
        for (var i = 0; i <= st.step; i++) {
          if (global.APP_STATE.active().result.series[i].depths[hit.id] >= 0.15) { arr = GEO.fmtTime(GEO.stepToHour(i)); break; }
        }
        html = '<b>' + b.name + '</b><br>地面高程 ' + b.gl.toFixed(1) + 'm<br>当前淹深 <b style="color:' + global.CHARTS.depthColor(dep) + '">' + dep.toFixed(2) + 'm</b><br>首次进水 ' + arr;
      } else if (hit.type === 'pump') {
        var p = GEO.byId[hit.id], info = f.pumps[hit.id];
        html = '<b>' + p.name + '</b><br>' + p.units + ' 台机组（单机 ' + p.qUnit + 'm³/s, ' + p.kw + 'kW）<br>状态：' +
          (info.on ? '运行 ' + info.units + ' 台，负荷 ' + Math.round(info.load * 100) + '%' : '停机');
      } else {
        var g = GEO.byId[hit.id];
        var nm = g.name || GEO.BASINS.filter(function (d) { return d.gate === hit.id; })[0].name + '分洪闸';
        html = '<b>' + hit.id + ' ' + nm + '</b><br>当前开度 ' + Math.round(f.openings[hit.id] * 100) + '%';
      }
      tip.innerHTML = html;
      tip.hidden = false;
      tip.style.left = (e.clientX - rect.left + 14) + 'px';
      tip.style.top = (e.clientY - rect.top + 14) + 'px';
    });
    mapCanvas.addEventListener('mouseleave', function () { tip.hidden = true; });

    // 键盘
    window.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
      if (e.code === 'ArrowLeft') jumpTo(global.APP_STATE.getState().step - (e.shiftKey ? 10 : 1));
      if (e.code === 'ArrowRight') jumpTo(global.APP_STATE.getState().step + (e.shiftKey ? 10 : 1));
    });

    // 导入导出
    $('btnExport').addEventListener('click', function () {
      var blob = new Blob([global.STORE.exportJson(global.APP_STATE.getState())], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = '潮汐防洪推演_' + Date.now() + '.json';
      a.click(); URL.revokeObjectURL(a.href);
      toast('推演状态已导出');
    });
    $('btnImport').addEventListener('click', function () { $('fileImport').click(); });
    $('fileImport').addEventListener('change', function (e) {
      var file = e.target.files[0]; if (!file) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var imported = global.STORE.importJson(rd.result);
          global.APP_STATE.init(imported);
          $('scenarioSel').value = imported.scenarioId;
          renderAll(true);
          toast('已导入推演状态');
        } catch (err) { toast('导入失败：' + err.message); }
      };
      rd.readAsText(file);
    });

    // 模拟断连：直接卸载当前内存（不清存储），随后弹恢复框
    $('btnCrash').addEventListener('click', function () {
      global.APP_STATE.persist();
      location.reload();
    });

    window.addEventListener('resize', function () { drawAll(); });
  }

  function advisorReset() { /* 缓存随 APP_STATE 重建自动失效 */ }

  function showResume(st) {
    var modal = $('resumeModal');
    var scm = st.schemes.filter(function (s) { return s.id === st.activeId; })[0] || st.schemes[0];
    $('resumeInfo').innerHTML = '保存于 ' + new Date(st.savedAt).toLocaleString('zh-CN') +
      '，情景「' + GEO.SCENARIOS[st.scenarioId].name + '」，当前方案「' + scm.name +
      '」，时间轴位于 <b>' + GEO.fmtTime(GEO.stepToHour(st.step)) + '</b>（共 48 小时）。';
    modal.hidden = false;
    $('btnResume').onclick = function () { modal.hidden = true; boot(st); };
    $('btnDiscard').onclick = function () { modal.hidden = true; global.STORE.clear(); boot(null); };
  }

  function boot(resume) {
    var sel0 = $('scenarioSel');
    if (!sel0.options.length) {
      Object.keys(GEO.SCENARIOS).forEach(function (sid) {
        var o = document.createElement('option');
        o.value = sid; o.textContent = GEO.SCENARIOS[sid].name;
        sel0.appendChild(o);
      });
    }
    global.APP_STATE.init(resume);
    var st = global.APP_STATE.getState();
    var marks = [];
    for (var hh = 0; hh <= 48; hh += 4) marks.push('<span>' + GEO.fmtTime(GEO.stepToHour(GEO.hourToStep(hh))) + '</span>');
    $('tlMarks').innerHTML = marks.join('');
    bindEvents();
    $('scenarioSel').value = st.scenarioId;
    document.querySelector('.sp[data-sp="' + (st.speed || 1) + '"]').classList.add('active');
    speed = st.speed || 1;
    renderAll(true);
    jumpTo(st.step || 0);
    if (resume) toast('已恢复到 ' + GEO.fmtTime(GEO.stepToHour(st.step)) + '，按空格继续推演');
    setInterval(function () { global.APP_STATE.persist(); }, 15000);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var saved = global.STORE.load();
    if (saved && saved.step > 0) showResume(saved);
    else boot(saved);
  });
})(typeof window !== 'undefined' ? window : globalThis);
