/* 地图渲染：街区积水面、河道/海面、泵站负荷、闸门状态、倒灌箭头、tooltip、对比双图 */
(function (global) {
  'use strict';
  var GEO = global.GEO, CHARTS = global.CHARTS;

  function setup(canvas) { return CHARTS.setup(canvas); }

  function polyPath(ctx, pts) {
    ctx.beginPath();
    pts.forEach(function (p, i) { i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]); });
    ctx.closePath();
  }

  function strokePath(ctx, pts) {
    ctx.beginPath();
    pts.forEach(function (p, i) { i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]); });
    ctx.stroke();
  }

  function centroid(pts) {
    var x = 0, y = 0;
    pts.forEach(function (p) { x += p[0]; y += p[1]; });
    return [x / pts.length, y / pts.length];
  }

  var rainDrops = [];

  function drawBase(ctx, W, H, frame) {
    // 海面
    ctx.fillStyle = '#0a2233';
    ctx.fillRect(0, 0, W, H);
    polyPath(ctx, [[330, 690], [760, 690], [760, 700], [300, 700]]);
    ctx.fillStyle = '#0e2f47';
    polyPath(ctx, [[250, 700], [760, 700], [760, 640], [470, 640], [430, 668], [350, 620], [300, 660], [250, 700]]);
    ctx.fill();
    // 海浪纹理
    ctx.strokeStyle = 'rgba(127,212,255,.18)'; ctx.lineWidth = 1;
    for (var i = 0; i < 6; i++) {
      var yy = 648 + i * 9;
      ctx.beginPath();
      for (var xx = 380; xx < 760; xx += 8) {
        ctx.lineTo(xx, yy + Math.sin((xx + frame * 0.8 + i * 9) / 14) * 2);
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#5d93b8'; ctx.font = '12px sans-serif';
    ctx.fillText('东 海', 660, 675);

    // 蓄滞洪区
    GEO.BASINS.forEach(function (d) {
      ctx.fillStyle = '#123328';
      ctx.fillRect(d.rect[0], d.rect[1], d.rect[2], d.rect[3]);
      ctx.strokeStyle = '#2e6b4f'; ctx.setLineDash([5, 4]);
      ctx.strokeRect(d.rect[0], d.rect[1], d.rect[2], d.rect[3]);
      ctx.setLineDash([]);
      strokePath(ctx, d.canal);
      ctx.fillStyle = '#7fc7a0'; ctx.font = '11px sans-serif';
      ctx.fillText(d.name, d.rect[0] + 8, d.rect[1] + 18);
    });

    // 河道底床
    ctx.strokeStyle = '#10384c'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    GEO.RIVERS.forEach(function (r) { ctx.lineWidth = r.width + 6; strokePath(ctx, r.path); });
  }

  function drawFrame(canvas, run, step, opts) {
    opts = opts || {};
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 760, cssH = canvas.clientHeight || 700;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    var ctx = canvas.getContext('2d');
    var scaleX = cssW / 760, scaleY = cssH / 700;
    if (opts.fit === 'contain') { var sf = Math.min(scaleX, scaleY); scaleX = scaleY = sf; }
    ctx.setTransform(dpr * scaleX, 0, 0, dpr * scaleY, 0, 0);
    var d = { ctx: ctx, w: 760, h: 700, sx: scaleX, sy: scaleY };
    var frame = opts.frame || 0;
    drawBase(ctx, d.w, d.h, frame);

    var f = run.series[step];

    // 河道水体（宽度随水位增大，颜色随高水位变红）
    GEO.RIVERS.forEach(function (r) {
      var lv = f.river[r.id];
      var w = r.width + Math.max(0, lv + 1.2) * 2.5;
      var hot = Math.max(0, Math.min(1, (lv - 1.2) / 2.0));
      var col = hot > 0
        ? 'rgb(' + (16 + hot * 180) + ',' + (120 - hot * 60) + ',' + (150 - hot * 90) + ')'
        : '#177093';
      ctx.strokeStyle = col; ctx.lineWidth = w;
      strokePath(ctx, r.path);
      // 流向箭头
      var flow = r.id === 'r1' ? f.flows.g0 : 0;
      ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = '9px sans-serif';
      for (var i = 1; i < r.path.length; i++) {
        var a = r.path[i - 1], b = r.path[i];
        var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        var ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (r.id === 'r1' && i >= r.path.length - 1 && f.flows.g0 < 0) ang += Math.PI; // 倒灌反向
        var ph = (frame * 0.06) % 1;
        var px = mx + Math.cos(ang) * (ph - 0.5) * 26;
        var py = my + Math.sin(ang) * (ph - 0.5) * 26;
        ctx.save(); ctx.translate(px, py); ctx.rotate(ang);
        ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(-3, -3); ctx.lineTo(-3, 3); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    });

    // 街区积水面
    GEO.BLOCKS.forEach(function (b) {
      var dep = f.depths[b.id];
      polyPath(ctx, b.poly);
      ctx.fillStyle = dep > 0.02 ? hexA(CHARTS.depthColor(dep), Math.min(0.9, 0.25 + dep / 0.5)) : 'rgba(40,58,76,.5)';
      ctx.fill();
      ctx.strokeStyle = dep > 0.15 ? CHARTS.depthColor(dep) : '#34506b';
      ctx.lineWidth = dep > 0.27 ? 2 : 1;
      ctx.stroke();
      var c = centroid(b.poly);
      ctx.fillStyle = dep > 0.15 ? '#0b141d' : '#a9c2d8';
      ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(b.name, c[0], c[1] - 6);
      ctx.font = '11px sans-serif';
      ctx.fillStyle = dep > 0.05 ? CHARTS.depthColor(dep) : '#6b86a0';
      ctx.fillText(dep >= 0.01 ? '积水 ' + dep.toFixed(2) + 'm' : '地面 ' + b.gl.toFixed(1) + 'm', c[0], c[1] + 10);
      ctx.textAlign = 'left';
    });

    // 蓄滞洪区水位
    f.basin.forEach(function (bs) {
      var d2 = GEO.byId[bs.id];
      var ratio = Math.min(1, bs.depth / bs.cap);
      var hh = d2.rect[3] * ratio;
      ctx.fillStyle = 'rgba(61,168,128,' + (0.15 + ratio * 0.5) + ')';
      ctx.fillRect(d2.rect[0], d2.rect[1] + d2.rect[3] - hh, d2.rect[2], hh);
      ctx.fillStyle = '#bfe8d4'; ctx.font = '10px sans-serif';
      ctx.fillText('蓄水深 ' + bs.depth.toFixed(2) + ' / ' + bs.cap.toFixed(1) + 'm', d2.rect[0] + 8, d2.rect[1] + d2.rect[3] - 8);
    });

    // 泵站
    GEO.PUMPS.forEach(function (p) {
      var info = f.pumps[p.id];
      var over = info.load > 1.02;
      ctx.beginPath(); ctx.arc(p.xy[0], p.xy[1], 8, 0, Math.PI * 2);
      ctx.fillStyle = !info.on ? '#33485c' : over ? '#e25252' : '#4dd08b';
      ctx.fill();
      ctx.strokeStyle = '#0b141d'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(info.on ? info.units + 'P' : '停', p.xy[0], p.xy[1] + 3);
      ctx.textAlign = 'left';
      if (over) {
        var pulse = 10 + Math.sin(frame * 0.25) * 2;
        ctx.strokeStyle = 'rgba(226,82,82,.8)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.xy[0], p.xy[1], pulse, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = '#c9d9e8'; ctx.font = '10px sans-serif';
      ctx.fillText(p.name + (info.on ? ' ' + Math.round(info.load * 100) + '%' : ''), p.xy[0] + 11, p.xy[1] - 8);
    });

    // 闸门
    var gateObjs = [GEO.TIDE_GATE].concat(GEO.DRAIN_GATES);
    gateObjs.forEach(function (g) {
      var open = f.openings[g.id];
      drawGate(ctx, g.xy, open, g.id, f.flows, frame);
    });
    GEO.BASINS.forEach(function (bs2) {
      drawGate(ctx, bs2.gateXY, f.openings[bs2.gate], bs2.gate, f.flows, frame, true);
    });

    // 河道水位标尺标签
    ctx.fillStyle = '#8fd8ff'; ctx.font = '10px sans-serif';
    ctx.fillText('主河 ' + f.river.r1.toFixed(2) + 'm', GEO.RIVERS[0].path[2][0] + 12, GEO.RIVERS[0].path[2][1] - 8);
    ctx.fillText('支河 ' + f.river.r2.toFixed(2) + 'm', 120, 262);
    ctx.fillStyle = '#7fd4ff';
    ctx.fillText('潮位 ' + f.sea.toFixed(2) + 'm', 452, 650);
  }

  function drawGate(ctx, xy, open, id, flows, frame, isDiv) {
    var back = false;
    if (id === 'G0') back = flows.g0 < -0.3;
    else if (flows.drain && flows.drain[id] != null) back = flows.drain[id] < -0.3;
    else if (flows.div) {
      var bid = id === 'D1' ? 'd1' : 'd2';
      back = (flows.div[bid] || 0) < -0.3;
    }
    var x = xy[0], y = xy[1];
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = open > 0.02 ? (back ? '#e25252' : '#e0b13d') : '#54677a';
    ctx.strokeStyle = '#0b141d'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.rect(-6, -4, 12, 8); ctx.fill(); ctx.stroke();
    if (open > 0.02) {
      ctx.fillStyle = '#0b141d';
      ctx.fillRect(-4, -2, 8 * open, 4);
    }
    ctx.restore();
    if (back) {
      ctx.strokeStyle = 'rgba(226,82,82,' + (0.5 + Math.sin(frame * 0.3) * 0.3) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = back ? '#f09a9a' : '#9fb6cc'; ctx.font = '9px sans-serif';
    ctx.fillText(id + ' ' + Math.round(open * 100) + '%', x + 8, y + 12);
  }

  function hexA(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function hitTest(px, py) {
    for (var i = 0; i < GEO.BLOCKS.length; i++) {
      var b = GEO.BLOCKS[i], p = b.poly;
      var inside = false;
      for (var j = 0, k2 = p.length - 1; j < p.length; k2 = j++) {
        if (((p[j][1] > py) !== (p[k2][1] > py)) &&
          px < (p[k2][0] - p[j][0]) * (py - p[j][1]) / (p[k2][1] - p[j][1]) + p[j][0]) inside = !inside;
      }
      if (inside) return { type: 'block', id: b.id };
    }
    var gates = [GEO.TIDE_GATE].concat(GEO.DRAIN_GATES);
    for (var m = 0; m < gates.length; m++) {
      if (Math.abs(px - gates[m].xy[0]) < 10 && Math.abs(py - gates[m].xy[1]) < 10) return { type: 'gate', id: gates[m].id };
    }
    for (var n = 0; n < GEO.PUMPS.length; n++) {
      if (Math.abs(px - GEO.PUMPS[n].xy[0]) < 10 && Math.abs(py - GEO.PUMPS[n].xy[1]) < 10) return { type: 'pump', id: GEO.PUMPS[n].id };
    }
    return null;
  }

  function fitScale(canvas) {
    var cssW = canvas.clientWidth || 760, cssH = canvas.clientHeight || 700;
    return { x: cssW / 760, y: cssH / 700 };
  }
  global.MAP = { drawFrame: drawFrame, drawBase: drawBase, hitTest: hitTest, centroid: centroid, fitScale: fitScale };
})(typeof window !== 'undefined' ? window : globalThis);
