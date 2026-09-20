/* 应用状态：方案管理、重算调度、情景切换、持久化 */
(function (global) {
  'use strict';
  var GEO = global.GEO;

  var state = null;
  var schemeSeq = 0;
  var recomputeTimer = null;
  var advisorCache = {};

  function uid(name) { schemeSeq++; return 'sc' + Date.now().toString(36) + '_' + schemeSeq + '_' + name; }

  function evaluateScheme(scm, scenarioId) {
    var sc = GEO.SCENARIOS[scenarioId];
    var ev = global.ADVISOR.evaluate(GEO, sc, scm.plan);
    scm.result = ev.result;
    scm.score = ev.score;
    scm.scenarioId = scenarioId;
    return scm;
  }

  function makeScheme(name, plan, locked) {
    var scm = { id: uid(name), name: name, plan: plan, locked: !!locked, createdAt: Date.now() };
    return evaluateScheme(scm, state.scenarioId);
  }

  function freshState(scenarioId) {
    state = global.STORE.blankState();
    state.scenarioId = scenarioId || 's2';
    var base = makeScheme('基准调度（存在隐患）', global.SIM_ENGINE_PART1.baselinePlan(), true);
    state.activeId = base.id;
    state.schemes = [base];
    state.compareIds = [base.id];
    persist();
    return state;
  }

  function init(resumeState) {
    if (resumeState) {
      state = resumeState;
      // 重算所有方案（序列不持久化，恢复后即时演算）
      state.schemes.forEach(function (scm) { evaluateScheme(scm, state.scenarioId); });
      advisorCache = {};
    } else {
      freshState('s2');
    }
    return state;
  }

  function persist() { global.STORE.save(state); }

  function getState() { return state; }
  function active() {
    return state.schemes.filter(function (s) { return s.id === state.activeId; })[0] || state.schemes[0];
  }
  function byId(id) { return state.schemes.filter(function (s) { return s.id === id; })[0]; }

  function requestRecompute(delay) {
    if (recomputeTimer) clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(function () {
      var scm = active();
      if (!scm.locked) {
        evaluateScheme(scm, state.scenarioId);
        delete advisorCache[scm.id];
        persist();
        global.APP_API.onRecomputed();
      }
    }, delay == null ? 180 : delay);
  }

  function recomputeAll(scenarioId) {
    state.scenarioId = scenarioId;
    advisorCache = {};
    state.schemes.forEach(function (s) { evaluateScheme(s, scenarioId); });
    state.step = 0;
    persist();
  }

  function copyActive() {
    var cur = active();
    var np = global.SIM_ENGINE_PART1.clonePlan(cur.plan);
    var scm = makeScheme(cur.name + '（副本）', np, false);
    state.schemes.push(scm);
    state.activeId = scm.id;
    if (state.compareIds.indexOf(scm.id) < 0) state.compareIds.push(scm.id);
    persist();
    return scm;
  }

  function addPreset(alt) {
    var scm = makeScheme(alt.name.length > 16 ? alt.name.slice(0, 16) : alt.name, global.SIM_ENGINE_PART1.clonePlan(alt.ev.plan), false);
    state.schemes.push(scm);
    state.activeId = scm.id;
    if (state.compareIds.indexOf(scm.id) < 0) state.compareIds.push(scm.id);
    persist();
    return scm;
  }

  function removeScheme(id) {
    var scm = byId(id);
    if (!scm || scm.locked) return;
    state.schemes = state.schemes.filter(function (s) { return s.id !== id; });
    state.compareIds = state.compareIds.filter(function (x) { return x !== id; });
    if (state.activeId === id) state.activeId = state.schemes[0].id;
    persist();
  }

  function openScheme(id) { state.activeId = id; persist(); }
  function toggleCompare(id) {
    var i = state.compareIds.indexOf(id);
    if (i >= 0) state.compareIds.splice(i, 1);
    else state.compareIds.push(id);
    persist();
  }

  function getAdvisor() {
    var scm = active();
    if (!advisorCache[scm.id]) {
      advisorCache[scm.id] = global.ADVISOR.recommend(GEO, GEO.SCENARIOS[state.scenarioId], scm.plan, scm.result);
    }
    return advisorCache[scm.id];
  }

  global.APP_STATE = {
    init: init, freshState: freshState, persist: persist, getState: getState,
    active: active, byId: byId, requestRecompute: requestRecompute, recomputeAll: recomputeAll,
    copyActive: copyActive, addPreset: addPreset, removeScheme: removeScheme,
    openScheme: openScheme, toggleCompare: toggleCompare, getAdvisor: getAdvisor
  };
})(typeof window !== 'undefined' ? window : globalThis);
