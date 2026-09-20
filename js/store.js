/* 断点续演：方案、情景、时间轴位置自动持久化；支持断连恢复、JSON 导入导出、模拟崩溃 */
(function (global) {
  'use strict';

  var KEY = 'tidal-flood-sim-v1';

  function nowTs() { return new Date().toISOString(); }

  function blankState() {
    return {
      version: 1,
      scenarioId: 's2',
      activeId: 'base',
      step: 0,
      playing: false,
      speed: 1,
      compareIds: [],
      schemes: [],
      savedAt: nowTs()
    };
  }

  function save(state) {
    try {
      state.savedAt = nowTs();
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) { return false; }
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var st = JSON.parse(raw);
      if (!st || st.version !== 1 || !st.schemes || !st.schemes.length) return null;
      st.playing = false; // 恢复后一律暂停，由用户继续
      return st;
    } catch (e) { return null; }
  }

  function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }

  function exportJson(state) { return JSON.stringify(state, null, 2); }

  function importJson(text) {
    var st = JSON.parse(text);
    if (!st || st.version !== 1 || !Array.isArray(st.schemes)) throw new Error('文件格式不正确');
    st.playing = false;
    return st;
  }

  global.STORE = { KEY: KEY, blankState: blankState, save: save, load: load, clear: clear, exportJson: exportJson, importJson: importJson };
})(typeof window !== 'undefined' ? window : globalThis);
