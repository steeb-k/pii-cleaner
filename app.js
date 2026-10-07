/* app.js - DOM wiring for PII Cleaner. No network calls, no storage. */
(function () {
  'use strict';

  var PII = window.PIISanitizer;
  var session = PII.createSession();

  var state = {
    lastFilename: null,
    lastResult: null,
    legendSort: { col: 'type', dir: 1 },
    activeTab: 'output'
  };

  // ---- element refs ----
  var el = {
    inputText: document.getElementById('input-text'),
    fileInput: document.getElementById('file-input'),
    formatLabel: document.getElementById('format-label'),
    parseError: document.getElementById('parse-error'),
    categoryToggles: document.getElementById('category-toggles'),
    customHost: document.getElementById('custom-host'),
    customUser: document.getElementById('custom-user'),
    customDomain: document.getElementById('custom-domain'),
    customOther: document.getElementById('custom-other'),
    legendImportFile: document.getElementById('legend-import-file'),
    legendImportStatus: document.getElementById('legend-import-status'),
    sanitizeBtn: document.getElementById('sanitize-btn'),
    clearBtn: document.getElementById('clear-btn'),
    clearConfirm: document.getElementById('clear-confirm'),
    clearConfirmYes: document.getElementById('clear-confirm-yes'),
    clearConfirmNo: document.getElementById('clear-confirm-no'),
    statsLine: document.getElementById('stats-line'),
    outputText: document.getElementById('output-text'),
    copyBtn: document.getElementById('copy-btn'),
    copyStatus: document.getElementById('copy-status'),
    downloadOutputBtn: document.getElementById('download-output-btn'),
    legendFilter: document.getElementById('legend-filter'),
    legendTbody: document.getElementById('legend-tbody'),
    downloadLegendJsonBtn: document.getElementById('download-legend-json-btn'),
    downloadLegendCsvBtn: document.getElementById('download-legend-csv-btn'),
    leaksList: document.getElementById('leaks-list'),
    leakCountBadge: document.getElementById('leak-count-badge'),
    cspIndicator: document.getElementById('csp-indicator'),
    tabButtons: Array.prototype.slice.call(document.querySelectorAll('.tab-btn')),
    tabPanels: {
      output: document.getElementById('tab-output'),
      legend: document.getElementById('tab-legend'),
      leaks: document.getElementById('tab-leaks')
    }
  };

  // ---- CSP live indicator ----
  function checkCsp() {
    var meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (meta && meta.getAttribute('content') && meta.getAttribute('content').indexOf("default-src 'none'") !== -1) {
      el.cspIndicator.textContent = 'CSP active';
      el.cspIndicator.classList.add('ok');
    } else {
      el.cspIndicator.textContent = 'CSP missing!';
    }
  }
  checkCsp();

  // ---- category toggles ----
  var TYPE_LABELS = {
    HOST: 'Hostnames', USER: 'Usernames', DOMAIN: 'Domains', EMAIL: 'Emails',
    IP: 'IP addresses', MAC: 'MAC addresses', SID: 'SIDs', ID: 'IDs/GUIDs',
    PATH: 'User paths', URL: 'URLs', PHONE: 'Phone numbers', CUSTOM: 'Custom lists'
  };

  PII.TYPES.forEach(function (type) {
    var wrap = document.createElement('label');
    wrap.className = 'toggle-item';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.type = type;
    wrap.appendChild(cb);
    var span = document.createElement('span');
    span.textContent = TYPE_LABELS[type] || type;
    wrap.appendChild(span);
    el.categoryToggles.appendChild(wrap);
  });

  function getEnabledMap() {
    var enabled = {};
    el.categoryToggles.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      enabled[cb.dataset.type] = cb.checked;
    });
    return enabled;
  }

  // ---- format auto-detect label ----
  function updateFormatLabel() {
    var text = el.inputText.value;
    if (!text.trim()) {
      el.formatLabel.textContent = 'format: (none)';
      return;
    }
    var fmt = PII.detectFormat(text);
    el.formatLabel.textContent = 'format: ' + fmt;
  }
  el.inputText.addEventListener('input', function () {
    // Typed/pasted content no longer belongs to the previously loaded file.
    state.lastFilename = null;
    updateFormatLabel();
  });

  // ---- file picker (local only, FileReader) ----
  el.fileInput.addEventListener('change', function () {
    var file = el.fileInput.files && el.fileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      el.inputText.value = String(reader.result);
      state.lastFilename = file.name;
      updateFormatLabel();
      // allow picking the same file again later (e.g. after Clear)
      el.fileInput.value = '';
    };
    reader.onerror = function () {
      showParseError('Could not read file: ' + (reader.error ? reader.error.message : 'unknown error'));
    };
    reader.readAsText(file);
  });

  // ---- legend import ----
  el.legendImportFile.addEventListener('change', function () {
    var file = el.legendImportFile.files && el.legendImportFile.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var json = JSON.parse(String(reader.result));
        var res = session.importLegend(json) || { imported: 0, skipped: 0 };
        el.legendImportStatus.textContent = 'Imported ' + res.imported + ' entries' +
          (res.skipped ? ' (' + res.skipped + ' skipped: invalid or conflicting with this session).' : '.');
        renderLegend();
      } catch (e) {
        el.legendImportStatus.textContent = 'Import failed: ' + e.message;
      }
      // allow re-importing the same file
      el.legendImportFile.value = '';
    };
    reader.onerror = function () {
      el.legendImportStatus.textContent = 'Import failed: could not read file.';
      el.legendImportFile.value = '';
    };
    reader.readAsText(file);
  });

  // ---- error display ----
  function showParseError(msg, isWarning) {
    if (!msg) {
      el.parseError.hidden = true;
      el.parseError.textContent = '';
      return;
    }
    el.parseError.hidden = false;
    el.parseError.textContent = (isWarning ? 'Warning: ' : 'Error: ') + msg;
  }

  // ---- sanitize ----
  function splitLines(value) {
    return String(value || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
  }

  function applyCustomLists() {
    session.addCustom('HOST', splitLines(el.customHost.value));
    session.addCustom('USER', splitLines(el.customUser.value));
    session.addCustom('DOMAIN', splitLines(el.customDomain.value));
    session.addCustom('CUSTOM', splitLines(el.customOther.value));
  }

  function runSanitize() {
    applyCustomLists();
    var enabled = getEnabledMap();
    var result = session.sanitize(el.inputText.value, { enabled: enabled, filename: state.lastFilename });
    state.lastResult = result;

    if (result.error) {
      showParseError(result.error);
    } else if (result.warning) {
      showParseError(result.warning, true);
    } else {
      showParseError(null);
    }

    el.outputText.value = result.output;
    renderStats(result);
    renderLegend();
    renderLeaks(result);
  }

  el.sanitizeBtn.addEventListener('click', runSanitize);

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runSanitize();
    }
  });

  // ---- stats ----
  function renderStats(result) {
    if (!result) {
      el.statsLine.textContent = 'No sanitize run yet.';
      return;
    }
    var parts = ['records: ' + result.records, 'replacements: ' + result.stats.total];
    var byType = result.stats.byType;
    var typeParts = Object.keys(byType).sort().map(function (t) { return t + '=' + byType[t]; });
    if (typeParts.length) parts.push(typeParts.join(' '));
    if (result.format) parts.unshift('format: ' + result.format);
    el.statsLine.textContent = parts.join(' | ');
  }

  // ---- legend table ----
  function renderLegend() {
    var legend = session.exportLegend();
    var filter = (el.legendFilter.value || '').toLowerCase();
    var rows = legend.entries.filter(function (e) {
      if (!filter) return true;
      return (e.token + ' ' + e.type + ' ' + e.original).toLowerCase().indexOf(filter) !== -1;
    });

    var col = state.legendSort.col;
    var dir = state.legendSort.dir;
    rows.sort(function (a, b) {
      var av = String(a[col]), bv = String(b[col]);
      if (col === 'count') { av = a.count; bv = b.count; return (av - bv) * dir; }
      // numeric-aware so {{HOST_2}} sorts before {{HOST_10}}
      return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' }) * dir;
    });

    el.legendTbody.innerHTML = '';
    rows.forEach(function (e) {
      var tr = document.createElement('tr');
      ['token', 'type', 'original', 'count'].forEach(function (key) {
        var td = document.createElement('td');
        td.textContent = e[key];
        tr.appendChild(td);
      });
      el.legendTbody.appendChild(tr);
    });
  }

  el.legendFilter.addEventListener('input', renderLegend);

  document.querySelectorAll('#legend-table th').forEach(function (th) {
    th.addEventListener('click', function () {
      var col = th.dataset.sort;
      if (state.legendSort.col === col) {
        state.legendSort.dir *= -1;
      } else {
        state.legendSort.col = col;
        state.legendSort.dir = 1;
      }
      renderLegend();
    });
  });

  // ---- leak check panel ----
  function listTypeForLeakType(type) {
    if (type === 'HOST') return { textarea: el.customHost, listType: 'HOST' };
    if (type === 'USER') return { textarea: el.customUser, listType: 'USER' };
    if (type === 'DOMAIN') return { textarea: el.customDomain, listType: 'DOMAIN' };
    return { textarea: el.customOther, listType: 'CUSTOM' };
  }

  function renderLeaks(result) {
    el.leaksList.innerHTML = '';
    var leaks = (result && result.leaks) || [];
    if (!leaks.length) {
      el.leakCountBadge.hidden = true;
      var ok = document.createElement('p');
      ok.className = 'hint';
      ok.textContent = 'No leaks detected.';
      el.leaksList.appendChild(ok);
      return;
    }
    el.leakCountBadge.hidden = false;
    el.leakCountBadge.textContent = String(leaks.length);

    leaks.forEach(function (leak) {
      var row = document.createElement('div');
      row.className = 'leak-row';

      var valSpan = document.createElement('span');
      valSpan.className = 'leak-value mono';
      valSpan.textContent = leak.value;
      row.appendChild(valSpan);

      var typeSpan = document.createElement('span');
      typeSpan.className = 'leak-type';
      typeSpan.textContent = leak.type;
      row.appendChild(typeSpan);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = 'Add to custom list & re-run';
      btn.addEventListener('click', function () {
        var target = listTypeForLeakType(leak.type);
        var ta = target.textarea;
        var existing = splitLines(ta.value);
        if (existing.indexOf(leak.value) === -1) {
          ta.value = existing.concat([leak.value]).join('\n');
        }
        runSanitize();
      });
      row.appendChild(btn);

      var ctxSpan = document.createElement('span');
      ctxSpan.className = 'leak-context mono';
      ctxSpan.textContent = leak.context;
      row.appendChild(ctxSpan);

      el.leaksList.appendChild(row);
    });
  }

  // ---- tabs ----
  el.tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var tab = btn.dataset.tab;
      state.activeTab = tab;
      el.tabButtons.forEach(function (b) {
        var active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      Object.keys(el.tabPanels).forEach(function (key) {
        el.tabPanels[key].hidden = key !== tab;
      });
    });
  });

  // ---- copy to clipboard ----
  el.copyBtn.addEventListener('click', function () {
    var text = el.outputText.value;
    function done(ok) {
      el.copyStatus.textContent = ok ? 'Copied.' : 'Copy failed.';
      setTimeout(function () { el.copyStatus.textContent = ''; }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallbackCopy(); });
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      try {
        el.outputText.focus();
        el.outputText.select();
        var ok = document.execCommand('copy');
        done(ok);
      } catch (e) {
        done(false);
      }
    }
  });

  // ---- downloads (Blob + anchor, no network) ----
  function triggerDownload(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function extFor(format) {
    if (format === 'json' || format === 'array') return '.json';
    if (format === 'ndjson') return '.ndjson';
    return '.txt';
  }

  function baseName(filename) {
    if (!filename) return 'output';
    var idx = filename.lastIndexOf('.');
    return idx > 0 ? filename.slice(0, idx) : filename;
  }

  el.downloadOutputBtn.addEventListener('click', function () {
    var result = state.lastResult;
    var format = result ? result.format : 'text';
    var name = baseName(state.lastFilename) + '.sanitized' + extFor(format);
    triggerDownload(name, el.outputText.value, 'text/plain');
  });

  el.downloadLegendJsonBtn.addEventListener('click', function () {
    var legend = session.exportLegend();
    triggerDownload('legend.json', JSON.stringify(legend, null, 2), 'application/json');
  });

  el.downloadLegendCsvBtn.addEventListener('click', function () {
    triggerDownload('legend.csv', session.exportLegendCSV(), 'text/csv');
  });

  // ---- clear session (in-page confirmation, no confirm()) ----
  el.clearBtn.addEventListener('click', function () {
    el.clearConfirm.hidden = false;
  });
  el.clearConfirmNo.addEventListener('click', function () {
    el.clearConfirm.hidden = true;
  });
  el.clearConfirmYes.addEventListener('click', function () {
    session.clear();
    el.inputText.value = '';
    el.outputText.value = '';
    el.customHost.value = '';
    el.customUser.value = '';
    el.customDomain.value = '';
    el.customOther.value = '';
    el.legendImportStatus.textContent = '';
    el.legendFilter.value = '';
    el.fileInput.value = '';
    el.legendImportFile.value = '';
    state.lastFilename = null;
    state.lastResult = null;
    showParseError(null);
    updateFormatLabel();
    renderStats(null);
    renderLegend();
    renderLeaks(null);
    el.clearConfirm.hidden = true;
  });

  // ---- initial render ----
  updateFormatLabel();
  renderStats(null);
  renderLegend();
  renderLeaks(null);
})();
