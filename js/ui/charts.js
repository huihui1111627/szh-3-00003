/* 过程曲线与时间轴：高DPI canvas、水情/工程分页、事件标记、拖拽联动 */
(function (global) {
  'use strict';
  var GEO = global.GEO;

  function setup(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || canvas.width;
    var h = canvas.clientHeight || canvas.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  var COLORS = {
    sea: '#7fd4ff', rain: '#8fa8c8', r1: '#4dd0e1', r2: '#36c2d9',
    depth: ['#4dd08b', '#9fd356', '#f5d042', '#f59045', '#e25252'],
    load: '#f5a623', gate: '#5b7a99', gateG0: '#e0b13d', pumpLoad: '#f5a623',
    cursor: '#ffffff', warn: '#ef5d5d', mid: '#e0b13d', grid: '#22384d', text: '#8aa3bb'
  };

  function depthColor(d) {
    if (d < 0.05) return COLORS.depth[0];
    if (d < 0.15) return COLORS.depth[1];
    if (d < 0.27) return COLORS.depth[2];
    if (d < 0.45) return COLORS.depth[3];
    return COLORS.depth[4];
  }

  function drawGrid(ctx, x0, x1, y0, y1, yMin, yMax, nY, fmtY) {
    ctx.strokeStyle = COLORS.grid; ctx.fillStyle = COLORS.text;
    ctx.lineWidth = 1; ctx.font = '10px sans-serif';
    for (var i = 0; i <= nY; i++) {
      var yy = y1 - (y1 - y0) * i / nY;
      var val = yMin + (yMax - yMin) * i / nY;
      ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
      ctx.fillText(fmtY ? fmtY(val) : val.toFixed(1), 4, yy + 3);
    }
    ctx.textAlign = 'center';
    for (var hh = 0; hh <= 48; hh += 6) {
      var xx = x0 + (x1 - x0) * hh / 48;
      ctx.fillText(GEO.fmtClock(hh), xx, y1 + 14);
    }
    ctx.textAlign = 'left';
  }

  function pathLine(ctx, x0, x1, y0, y1, n, yMin, yMax, fn) {
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var x = x0 + (x1 - x0) * i / (n - 1);
      var yv = fn(i);
      var y = y1 - (y1 - y0) * Math.max(0, Math.min(1, (yv - yMin) / (yMax - yMin || 1)));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }

  function drawHydro(canvas, runs, step) {
    var d = setup(canvas), ctx = d.ctx;
    var x0 = 42, x1 = d.w - 14, y0 = 10, y1 = d.h - 26;
    ctx.clearRect(0, 0, d.w, d.h);
    var N = GEO.totalSteps();
    var s0 = runs[0].series;
    var yMin = -2, yMax = 5.2;
    drawGrid(ctx, x0, x1, y0, y1, yMin, yMax, 8, function (v) { return v.toFixed(1) + 'm'; });

    // 雨柱（按当前主方案全市平均）
    ctx.fillStyle = 'rgba(143,168,200,0.5)';
    for (var i = 0; i < N; i++) {
      var avg = s0[i].rain.reduce(function (a, b) { return a + b; }, 0) / s0[i].rain.length;
      var bh = avg / 50 * (y1 - y0) * 0.4;
      var x = x0 + (x1 - x0) * i / (N - 1);
      ctx.fillRect(x - 1, y0 + (y1 - y0) - bh, 2, bh);
    }

    var series2d = [[s0, COLORS.sea, '潮位', function (f) { return f.sea; }],
      [s0, COLORS.r1, '主河道', function (f) { return f.river.r1; }],
      [s0, COLORS.r2, '支河', function (f) { return f.river.r2; }]];
    runs.forEach(function (r, ri) {
      var col = ri === 0 ? COLORS.depth[4] : ['#f5a623', '#4dd0e1', '#ba68c8'][ri] || '#ccc';
      series2d.push([r.series, col, '最大淹深×2', function (f) {
        var md = 0; Object.keys(f.depths).forEach(function (k) { md = Math.max(md, f.depths[k]); });
        return -1 + md * 2;
      }]);
    });

    series2d.forEach(function (se) {
      ctx.strokeStyle = se[1]; ctx.lineWidth = se[2].indexOf('淹深') >= 0 ? 1.2 : 1.8;
      pathLine(ctx, x0, x1, y0, y1, N, yMin, yMax, function (i) { return se[3](se[0][i]); });
      ctx.stroke();
    });

    drawLegendChips(ctx, d.w - 14, y0 + 2, series2d.map(function (se) { return [se[2], se[1]]; }), 11);

    // 事件标记（告警区间）
    var warns = [];
    runs.forEach(function (r) { warns = warns.concat(r.warnings); });
    warns.forEach(function (w) {
      var xa = x0 + (x1 - x0) * w.start / (N - 1);
      var xb = x0 + (x1 - x0) * w.end / (N - 1);
      ctx.fillStyle = w.sev === 'high' ? 'rgba(239,93,93,0.13)' : 'rgba(224,177,61,0.12)';
      ctx.fillRect(xa, y0, Math.max(2, xb - xa), y1 - y0);
    });

    var cx = x0 + (x1 - x0) * step / (N - 1);
    ctx.strokeStyle = COLORS.cursor; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, y0); ctx.lineTo(cx, y1 + 2); ctx.stroke();

    var f = s0[step];
    ctx.fillStyle = COLORS.text; ctx.textAlign = 'left'; ctx.font = '11px sans-serif';
    ctx.fillText('潮位 ' + f.sea.toFixed(2) + 'm  主河 ' + f.river.r1.toFixed(2) + 'm  支河 ' + f.river.r2.toFixed(2) + 'm', x0 + 6, y0 + 12);
  }

  function drawEng(canvas, runs, step) {
    var d = setup(canvas), ctx = d.ctx;
    var x0 = 42, x1 = d.w - 14, y0 = 10, y1 = d.h - 26;
    var N = GEO.totalSteps();
    ctx.clearRect(0, 0, d.w, d.h);
    // 负荷 0-160%
    drawGrid(ctx, x0, x1, y0, y1, 0, 1.6, 8, function (v) { return Math.round(v * 100) + '%'; });

    var s0 = runs[0].series;
    // 所有泵站负荷（细线），当前方案
    GEO.PUMPS.forEach(function (p, pi) {
      ctx.strokeStyle = pi === 0 ? 'rgba(245,166,35,0.55)' : 'rgba(245,166,35,0.35)';
      ctx.lineWidth = 1;
      pathLine(ctx, x0, x1, y0, y1, N, 0, 1.6, function (i) { return s0[i].pumps[p.id].load; });
      ctx.stroke();
    });
    // 平均负荷粗线
    ctx.strokeStyle = COLORS.load; ctx.lineWidth = 2;
    pathLine(ctx, x0, x1, y0, y1, N, 0, 1.6, function (i) {
      var on = GEO.PUMPS.filter(function (p) { return s0[i].pumps[p.id].on; });
      if (!on.length) return 0;
      return on.reduce(function (a, p) { return a + s0[i].pumps[p.id].load; }, 0) / on.length;
    });
    ctx.stroke();
    // 100% 红线
    var y100 = y1 - (y1 - y0) * 1 / 1.6;
    ctx.strokeStyle = 'rgba(239,93,93,.7)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x0, y100); ctx.lineTo(x1, y100); ctx.stroke(); ctx.setLineDash([]);

    // 闸门开度（右侧逻辑轴：映射到 0-1.6 的下 60%）
    var gateIds = ['G0'].concat(GEO.DRAIN_GATES.map(function (g) { return g.id; })).concat(GEO.BASINS.map(function (b) { return b.gate; }));
    gateIds.forEach(function (gid, gi) {
      ctx.strokeStyle = gid === 'G0' ? 'rgba(224,177,61,.9)' : 'rgba(91,122,153,.7)';
      ctx.lineWidth = gid === 'G0' ? 1.8 : 1;
      pathLine(ctx, x0, x1, y0, y1, N, 0, 1.6, function (i) { return (s0[i].openings[gid] || 0) * 0.6; });
      ctx.stroke();
    });
    drawLegendChips(ctx, d.w - 14, y0 + 2, [['泵站负荷(橙)', COLORS.load], ['闸门开度(蓝线,0-60%)', COLORS.gate], ['G0挡潮闸(金)', COLORS.gateG0]], 11);

    var cx = x0 + (x1 - x0) * step / (N - 1);
    ctx.strokeStyle = COLORS.cursor; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, y0); ctx.lineTo(cx, y1 + 2); ctx.stroke();
  }

  function drawLegendChips(ctx, rightX, y, items, fs) {
    ctx.font = fs + 'px sans-serif'; ctx.textAlign = 'right';
    var x = rightX;
    for (var i = items.length - 1; i >= 0; i--) {
      var label = items[i][0], col = items[i][1];
      var w = ctx.measureText(label).width;
      ctx.fillStyle = col; ctx.fillText(label, x, y + 10);
      x -= w + 14;
      ctx.fillRect(x - 8, y + 2, 10, 3);
      x -= 6;
    }
    ctx.textAlign = 'left';
  }

  // 时间轴：背景雨强 + 潮位轮廓 + 告警区间 + 游标；返回 x->step 映射函数
  function drawTimeline(canvas, run, step, events) {
    var d = setup(canvas), ctx = d.ctx;
    var x0 = 12, x1 = d.w - 12, y0 = 6, y1 = d.h - 8;
    var N = GEO.totalSteps();
    ctx.clearRect(0, 0, d.w, d.h);
    ctx.fillStyle = '#101c29'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

    // 潮位填充
    var yMin = -2, yMax = 3.2;
    ctx.beginPath();
    ctx.moveTo(x0, y1);
    for (var i = 0; i < N; i++) {
      var x = x0 + (x1 - x0) * i / (N - 1);
      var y = y1 - (y1 - y0) * Math.max(0, Math.min(1, (run.series[i].sea - yMin) / (yMax - yMin)));
      ctx.lineTo(x, y);
    }
    ctx.lineTo(x1, y1); ctx.closePath();
    ctx.fillStyle = 'rgba(127,212,255,.18)'; ctx.fill();

    // 雨强柱
    ctx.fillStyle = 'rgba(143,168,200,.8)';
    for (var j = 0; j < N; j++) {
      var f = run.series[j];
      var avg = f.rain.reduce(function (a, b) { return a + b; }, 0) / f.rain.length;
      var bh = avg / 50 * (y1 - y0);
      ctx.fillRect(x0 + (x1 - x0) * j / (N - 1) - 1, y1 - bh, 2, bh);
    }

    // 告警区间
    run.warnings.forEach(function (w) {
      var xa = x0 + (x1 - x0) * w.start / (N - 1);
      var xb = x0 + (x1 - x0) * w.end / (N - 1);
      ctx.fillStyle = w.sev === 'high' ? 'rgba(239,93,93,.55)' : 'rgba(224,177,61,.5)';
      ctx.fillRect(xa, y0, Math.max(2, xb - xa), 3);
    });

    // 游标
    var cx = x0 + (x1 - x0) * step / (N - 1);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, y0 - 2); ctx.lineTo(cx, y1 + 2); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(cx, y0 - 2, 4, 0, Math.PI * 2); ctx.fill();

    return function (clientX) {
      var rect = canvas.getBoundingClientRect();
      var xx = clientX - rect.left;
      var ratio = Math.max(0, Math.min(1, (xx - x0) / (x1 - x0)));
      return Math.round(ratio * (N - 1));
    };
  }

  global.CHARTS = {
    setup: setup, depthColor: depthColor, COLORS: COLORS,
    drawHydro: drawHydro, drawEng: drawEng, drawTimeline: drawTimeline
  };
})(typeof window !== 'undefined' ? window : globalThis);
