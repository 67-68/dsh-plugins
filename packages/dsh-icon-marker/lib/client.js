window.__ModuleLoader__.load({
  id: 'dsh-icon-marker',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var react = require('react');

    // ── locales ─────────────────────────────────────────────────────────────
    var zh = {
      settingsLabel: '会话图标',
      loading: '正在读取设置…',
      error: '设置读取失败',
      hideStatusLabel: '隐藏 DSH 原生状态点',
      on: '开',
      off: '关',
      stateMappingTitle: '会话状态自动映射',
      rulesTitle: '输出正则自动规则',
      addRule: '添加规则',
      patternPlaceholder: '正则，如 balance not enough',
      flagsPlaceholder: 'flags，如 i',
      deleteRule: '删除',
      symbolsTitle: '符号',
      newSymbol: '新建符号',
      placeholderTitle: '设置图标',
      pickerTitle: '选择符号',
      clear: '清除',
      newSymbolShort: '新建',
      charLabel: '符号字符',
      labelLabel: '含义（hover 显示）',
      cancel: '取消',
      confirm: '确定',
      charError: '请输入一个 unicode 字符',
      labelError: '含义不能为空',
      'state.running': '生成中',
      'state.completed': '生成完成',
      'state.waitingApproval': '等待审批',
      'state.planReview': '计划待审',
      'state.waitingAnswer': '等待回答',
      'state.idle': '空闲',
    };
    var en = {
      settingsLabel: 'Session icons',
      loading: 'Reading settings…',
      error: 'Failed to read settings',
      hideStatusLabel: 'Hide native DSH status dot',
      on: 'On',
      off: 'Off',
      stateMappingTitle: 'Session-state auto mapping',
      rulesTitle: 'Output regex auto rules',
      addRule: 'Add rule',
      patternPlaceholder: 'Regex, e.g. balance not enough',
      flagsPlaceholder: 'Flags, e.g. i',
      deleteRule: 'Delete',
      symbolsTitle: 'Symbols',
      newSymbol: 'New symbol',
      placeholderTitle: 'Set icon',
      pickerTitle: 'Pick a symbol',
      clear: 'Clear',
      newSymbolShort: 'New',
      charLabel: 'Symbol character',
      labelLabel: 'Meaning (shown on hover)',
      cancel: 'Cancel',
      confirm: 'Confirm',
      charError: 'Please enter exactly one unicode character',
      labelError: 'Meaning cannot be empty',
      'state.running': 'Running',
      'state.completed': 'Generation complete',
      'state.waitingApproval': 'Waiting for approval',
      'state.planReview': 'Plan review',
      'state.waitingAnswer': 'Waiting for answer',
      'state.idle': 'Idle',
    };

    // ── default symbols (hardcoded; user symbols live in settings) ─────────
    var DEFAULT_SYMBOLS = [
      { key: 'balance-low', char: '⭕', label: 'balance 不足', builtin: true },
      { key: 'done', char: '💚', label: '生成完成', builtin: true },
      { key: 'error', char: '🔴', label: '错误', builtin: true },
      { key: 'running', char: '🟡', label: '进行中', builtin: true },
      { key: 'important', char: '⭐', label: '重要', builtin: true },
      { key: 'pinned', char: '📌', label: '已固定', builtin: true },
      { key: 'ok', char: '✅', label: '已通过', builtin: true },
      { key: 'rejected', char: '❌', label: '已拒绝', builtin: true },
      { key: 'paused', char: '💤', label: '搁置', builtin: true },
      { key: 'question', char: '❓', label: '有疑问', builtin: true },
    ];

    var STATE_DEFS = [
      { key: 'running' },
      { key: 'completed' },
      { key: 'waitingApproval' },
      { key: 'planReview' },
      { key: 'waitingAnswer' },
      { key: 'idle' },
    ];

    // ── shared refs ─────────────────────────────────────────────────────────
    var scopeRef = { scope: null };
    var sessionsRef = { list: null, service: null };
    var tRef = { t: function (key) { return key; } };

    function t(key) {
      try { return tRef.t(key); } catch (_err) { return key; }
    }

    function ownRowSelector() {
      return '[data-owner="dsh-icon-marker-row"]';
    }

    function removeOwnRows() {
      var nodes = document.querySelectorAll(ownRowSelector());
      for (var i = 0; i < nodes.length; i++) nodes[i].remove();
    }

    function settingsValue() {
      if (!scopeRef.scope) return null;
      var snap = scopeRef.scope.getSnapshot();
      if (!snap || snap.status !== 'ready') return null;
      return snap.value || null;
    }

    // ── symbol logic ────────────────────────────────────────────────────────
    function resolveSymbols(value) {
      var list = [];
      var seen = {};
      for (var i = 0; i < DEFAULT_SYMBOLS.length; i++) {
        var sym = DEFAULT_SYMBOLS[i];
        seen[sym.key] = true;
        list.push(sym);
      }
      var customs = (value && Array.isArray(value.symbols)) ? value.symbols : [];
      for (var j = 0; j < customs.length; j++) {
        var c = customs[j];
        if (!c || typeof c.key !== 'string' || typeof c.char !== 'string' || typeof c.label !== 'string') continue;
        if (seen[c.key]) continue;
        seen[c.key] = true;
        list.push({ key: c.key, char: c.char, label: c.label, builtin: false });
      }
      return list;
    }

    function findSymbol(symbols, key) {
      if (!key) return null;
      for (var i = 0; i < symbols.length; i++) {
        if (symbols[i].key === key) return symbols[i];
      }
      return null;
    }

    function graphemeCount(value) {
      var v = String(value || '');
      try {
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
          return Array.from(new Intl.Segmenter().segment(v)).length;
        }
      } catch (_err) { /* fall through */ }
      return Array.from(v).length;
    }

    function slugKey(label, existingKeys) {
      var base = String(label || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (!base) base = 'sym';
      var key = base;
      var index = 2;
      while (existingKeys[key]) {
        key = base + '-' + index;
        index += 1;
      }
      return key;
    }

    function fsmStateOf(summary) {
      if (!summary) return 'idle';
      var p = summary.pendingInteraction;
      if (p === 'approval') return 'waitingApproval';
      if (p === 'plan-review') return 'planReview';
      if (p === 'question') return 'waitingAnswer';
      if (summary.running) return 'running';
      if (summary.completed) return 'completed';
      return 'idle';
    }

    // ── settings writes ─────────────────────────────────────────────────────
    function writeObjectField(field, map) {
      if (!scopeRef.scope) return;
      if (!map || Object.keys(map).length === 0) {
        scopeRef.scope.unset(field);
      } else {
        scopeRef.scope.set(field, map);
      }
    }

    function writeArrayField(field, arr) {
      if (!scopeRef.scope) return;
      if (!arr || arr.length === 0) {
        scopeRef.scope.unset(field);
      } else {
        scopeRef.scope.set(field, arr);
      }
    }

    function writeManual(sessionId, key) {
      if (!scopeRef.scope || !sessionId) return;
      var value = settingsValue() || {};
      var map = Object.assign({}, value.sessions || {});
      if (key === null || key === undefined || key === '') {
        delete map[sessionId];
      } else {
        map[sessionId] = key;
      }
      writeObjectField('sessions', map);
    }

    function writeAuto(sessionId, key) {
      if (!scopeRef.scope || !sessionId || !key) return;
      var value = settingsValue() || {};
      if (value.sessions && value.sessions[sessionId]) return; // manual wins
      var map = Object.assign({}, value.autoSessions || {});
      if (map[sessionId] === key) return; // avoid self-triggering loops
      map[sessionId] = key;
      writeObjectField('autoSessions', map);
    }

    function writeStateSymbol(stateKey, key) {
      if (!scopeRef.scope || !stateKey) return;
      var value = settingsValue() || {};
      var map = Object.assign({}, value.stateSymbols || {});
      if (key === null || key === undefined || key === '') {
        delete map[stateKey];
      } else {
        map[stateKey] = key;
      }
      writeObjectField('stateSymbols', map);
    }

    function writeAutoRules(rules) {
      writeArrayField('autoRules', rules);
    }

    function writeHideStatus(hide) {
      if (!scopeRef.scope) return;
      scopeRef.scope.set('hideStatus', !!hide);
    }

    function addSymbol(char, label) {
      var value = settingsValue() || {};
      var existing = resolveSymbols(value);
      var existingKeys = {};
      for (var i = 0; i < existing.length; i++) existingKeys[existing[i].key] = true;
      var key = slugKey(label, existingKeys);
      var customs = (value.symbols && Array.isArray(value.symbols)) ? value.symbols.slice() : [];
      customs.push({ key: key, char: char, label: label });
      writeArrayField('symbols', customs);
      return key;
    }

    function removeCustomSymbol(key) {
      if (!scopeRef.scope || !key) return;
      var value = settingsValue() || {};
      var symbols = (value.symbols && Array.isArray(value.symbols)) ? value.symbols.slice() : [];
      var next = symbols.filter(function (s) { return s.key !== key; });
      writeArrayField('symbols', next);
    }

    // ── session-row identification ──────────────────────────────────────────
    function getSessionIdFromRow(row) {
      var keys = Object.keys(row || {});
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key.indexOf('__reactFiber$') !== 0 && key.indexOf('__reactInternalInstance$') !== 0) continue;
        var fiber = row[key];
        while (fiber) {
          var props = fiber.memoizedProps;
          if (props && props.node && typeof props.node.id === 'string' && props.node.title !== undefined) {
            return props.node.id;
          }
          fiber = fiber.return;
        }
      }
      return null;
    }

    function buildTitleMap(list) {
      var byTitle = new Map();
      var ids = list && list.ids ? list.ids : [];
      for (var i = 0; i < ids.length; i++) {
        var summary = list.byId[ids[i]];
        if (!summary || summary.blank) continue;
        var title = summary.displayTitle;
        var arr = byTitle.get(title);
        if (arr) arr.push(ids[i]);
        else byTitle.set(title, [ids[i]]);
      }
      return byTitle;
    }

    function isSessionRow(row) {
      var cls = String(row && row.className ? row.className : '');
      return cls.indexOf('sessionRow') !== -1;
    }

    function findTitleEl(row) {
      var children = row.children;
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.className && String(child.className).indexOf('title') !== -1) return child;
      }
      var spans = row.querySelectorAll('span');
      for (var j = 0; j < spans.length; j++) {
        var text = spans[j].textContent.trim();
        if (text !== '') return spans[j];
      }
      return null;
    }

    function findStatusSlot(row) {
      var children = row.children;
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.className && String(child.className).indexOf('slot') !== -1) return child;
      }
      return null;
    }

    function resolveIconFor(sid, summary, value) {
      var symbols = resolveSymbols(value);
      var manualKey = value && value.sessions ? value.sessions[sid] : null;
      var manual = manualKey ? findSymbol(symbols, manualKey) : null;
      if (manual) return { symbol: manual, source: 'manual' };
      var autoKey = value && value.autoSessions ? value.autoSessions[sid] : null;
      var auto = autoKey ? findSymbol(symbols, autoKey) : null;
      if (auto) return { symbol: auto, source: 'auto' };
      var stateKey = value && value.stateSymbols ? value.stateSymbols[fsmStateOf(summary)] : null;
      var state = stateKey ? findSymbol(symbols, stateKey) : null;
      if (state) return { symbol: state, source: 'state' };
      return null;
    }

    // ── row rendering ───────────────────────────────────────────────────────
    function findOwnMarker(row, sid) {
      var children = row.children;
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child && child.getAttribute && child.getAttribute('data-owner') === 'dsh-icon-marker-row' && child.getAttribute('data-session-id') === sid) {
          return child;
        }
      }
      return null;
    }

    function renderRows() {
      if (!scopeRef.scope) return;
      var snap = scopeRef.scope.getSnapshot();
      if (!snap || snap.status !== 'ready' || !snap.value) return;
      var list = sessionsRef.list ? sessionsRef.list.getSnapshot() : null;
      if (!list || list.phase !== 'ready') return;
      var value = snap.value;
      var byTitle = buildTitleMap(list);
      var liveMarkers = [];
      var rows = document.querySelectorAll('[role="treeitem"][aria-selected]');
      for (var r = 0; r < rows.length; r++) {
        (function (row) {
          if (!isSessionRow(row)) return;

          var slot = findStatusSlot(row);
          if (slot) slot.style.display = value.hideStatus ? 'none' : '';

          var sid = getSessionIdFromRow(row);
          var titleEl = findTitleEl(row);
          if (!sid && titleEl) {
            var titleText = titleEl.textContent.trim();
            var matches = byTitle.get(titleText);
            if (matches && matches.length === 1) sid = matches[0];
          }
          if (!sid) return;
          var summary = list.byId[sid];
          if (!summary) return;

          var pick = resolveIconFor(sid, summary, value);
          var char = pick ? pick.symbol.char : '+';
          var label = pick ? pick.symbol.label : t('placeholderTitle');
          var symbolKey = pick ? pick.symbol.key : '';
          var marker = findOwnMarker(row, sid);
          if (!marker) {
            marker = document.createElement('button');
            marker.type = 'button';
            marker.setAttribute('data-owner', 'dsh-icon-marker-row');
            marker.setAttribute('data-session-id', sid);
            marker.style.cssText = [
              'display:inline-flex', 'align-items:center', 'justify-content:center',
              'flex:none', 'width:16px', 'height:20px', 'margin:0 2px',
              'padding:0', 'border:none', 'background:transparent', 'cursor:pointer',
              'color:var(--dsw-alias-label-secondary,#9ca3af)',
              'font-size:12px', 'line-height:20px', 'border-radius:4px',
            ].join(';');
            marker.addEventListener('click', function (event) {
              event.preventDefault();
              event.stopPropagation();
              openSymbolPicker(marker, {
                allowClear: true,
                selectedKey: marker.getAttribute('data-symbol-key') || null,
                onPick: function (key) {
                  writeManual(sid, key);
                  renderAll();
                },
              });
            });
          }
          if (marker.textContent !== char) marker.textContent = char;
          if (marker.title !== label) marker.title = label;
          if (marker.getAttribute('data-symbol-key') !== symbolKey) {
            marker.setAttribute('data-symbol-key', symbolKey);
          }

          if (titleEl && titleEl.parentNode === row) {
            if (marker.nextSibling !== titleEl) row.insertBefore(marker, titleEl);
          } else if (marker.parentNode !== row) {
            row.insertBefore(marker, row.firstChild);
          }
          liveMarkers.push(marker);
        })(rows[r]);
      }

      var allMarkers = document.querySelectorAll(ownRowSelector());
      for (var m = 0; m < allMarkers.length; m++) {
        var stale = allMarkers[m];
        if (liveMarkers.indexOf(stale) === -1) {
          if (stale.parentNode) stale.parentNode.removeChild(stale);
        }
      }
    }

    function installRowObserver() {
      var observers = [];
      var rafId = 0;
      var onReady = null;

      function schedule() {
        if (rafId) return;
        rafId = requestAnimationFrame(function () {
          rafId = 0;
          renderAll();
        });
      }

      function startObserving() {
        if (!document.body) return;
        var observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        observers.push(observer);
        schedule();
      }

      if (document.readyState === 'loading') {
        onReady = startObserving;
        document.addEventListener('DOMContentLoaded', onReady);
      } else {
        startObserving();
      }

      return function cleanup() {
        if (onReady) document.removeEventListener('DOMContentLoaded', onReady);
        for (var i = 0; i < observers.length; i++) observers[i].disconnect();
        if (rafId) cancelAnimationFrame(rafId);
        removeOwnRows();
        closePicker();
        closeModal();
      };
    }

    // ── regex auto hook (current open session only) ─────────────────────────
    var autoHook = { currentSessionId: null, dispose: null, lastSeenSeq: 0 };

    function extractEventText(event) {
      if (!event || !event.type) return '';
      var data = event.data;
      if (event.type === 'assistant/message') {
        var content = data && data.message && data.message.content;
        if (Array.isArray(content)) {
          var parts = [];
          for (var i = 0; i < content.length; i++) {
            var block = content[i];
            if (block && (block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') {
              parts.push(block.text);
            }
          }
          return parts.join('\n');
        }
      } else if (event.type === 'text-chunks') {
        if (data && Array.isArray(data.texts)) return data.texts.join('');
      } else if (event.type === 'assistant/chunk') {
        var chunk = data && data.chunk;
        if (chunk && typeof chunk.text === 'string') return chunk.text;
      } else if (event.type === 'turn/end') {
        var reason = data && data.reason;
        if (reason && typeof reason.message === 'string') return reason.message;
        if (reason && reason.error && typeof reason.error.message === 'string') return reason.error.message;
      } else if (event.type === 'agent-error' || event.type === 'host/agent-error') {
        if (data && typeof data.message === 'string') return data.message;
      }
      return '';
    }

    function autoScan(session) {
      if (!session) return;
      var value = settingsValue();
      if (!value) return;
      var rules = value.autoRules || [];
      if (rules.length === 0) return;
      var manual = value.sessions && value.sessions[session.sessionId];
      var texts = [];
      var snap = null;
      try { snap = session.getSnapshot ? session.getSnapshot() : null; } catch (_err) { snap = null; }
      if (snap) {
        if (typeof snap.lastAgentError === 'string' && snap.lastAgentError) texts.push(snap.lastAgentError);
        if (snap.promptError && snap.promptError.error && typeof snap.promptError.error.message === 'string') {
          texts.push(snap.promptError.error.message);
        }
      }

      var events = session.events || [];
      var maxSeq = autoHook.lastSeenSeq;
      for (var i = 0; i < events.length; i++) {
        var event = events[i];
        if (!event || typeof event.seq !== 'number' || event.seq <= autoHook.lastSeenSeq) continue;
        var text = extractEventText(event);
        if (text) texts.push(text);
        if (event.seq > maxSeq) maxSeq = event.seq;
      }
      autoHook.lastSeenSeq = maxSeq;

      var haystack = texts.join('\n');
      if (!haystack) return;
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        if (!rule || typeof rule.pattern !== 'string' || rule.pattern === '') continue;
        var matched = false;
        try {
          // Always case-insensitive. `flags` is not surfaced in the UI anymore;
          // it stays in the schema only for older data compatibility.
          matched = new RegExp(rule.pattern, 'i').test(haystack);
        } catch (_err) {
          matched = false;
        }
        if (matched) {
          if (!manual) writeAuto(session.sessionId, rule.symbolKey || '');
          return;
        }
      }
    }

    function syncAutoHook() {
      var service = sessionsRef.service;
      var list = sessionsRef.list ? sessionsRef.list.getSnapshot() : null;
      if (!service || !list || list.phase !== 'ready') return;
      var current = list.current;
      if (current === autoHook.currentSessionId) return;
      if (autoHook.dispose) {
        autoHook.dispose();
        autoHook.dispose = null;
      }
      autoHook.currentSessionId = current;
      autoHook.lastSeenSeq = 0;
      if (typeof current !== 'string' || current === '') return;
      var binding = null;
      try { binding = service.binding(current); } catch (_err) { binding = null; }
      var session = binding && binding.session;
      if (!session) return;
      autoHook.dispose = session.subscribe(function () { autoScan(session); });
      autoScan(session);
    }

    function rescanCurrentSession() {
      var service = sessionsRef.service;
      var list = sessionsRef.list ? sessionsRef.list.getSnapshot() : null;
      if (!service || !list || list.phase !== 'ready') return;
      var current = list.current;
      if (typeof current !== 'string' || current === '') return;
      var binding = null;
      try { binding = service.binding(current); } catch (_err) { binding = null; }
      var session = binding && binding.session;
      if (!session) return;
      autoHook.lastSeenSeq = 0;
      autoScan(session);
    }

    // ── SymbolPicker + create modal (plain DOM) ─────────────────────────────
    var pickerState = { root: null, docDown: null };
    var modalState = { root: null };

    function closePicker() {
      if (pickerState.docDown) {
        document.removeEventListener('mousedown', pickerState.docDown);
        pickerState.docDown = null;
      }
      if (pickerState.root && pickerState.root.parentNode) {
        pickerState.root.parentNode.removeChild(pickerState.root);
      }
      pickerState.root = null;
    }

    function closeModal() {
      if (modalState.root && modalState.root.parentNode) {
        modalState.root.parentNode.removeChild(modalState.root);
      }
      modalState.root = null;
    }

    function openSymbolPicker(anchor, opts) {
      closePicker();
      var value = settingsValue() || {};
      var symbols = resolveSymbols(value);
      var root = document.createElement('div');
      root.setAttribute('data-owner', 'dsh-icon-marker-picker');
      root.style.cssText = [
        'position:fixed', 'z-index:10000', 'min-width:180px', 'max-width:320px',
        'background:var(--dsw-alias-bg-layer-3,#1f1f1f)',
        'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.4))',
        'border-radius:10px', 'padding:6px', 'box-shadow:0 8px 24px rgba(0,0,0,0.25)',
        'color:var(--dsw-alias-label-primary,#e5e7eb)',
      ].join(';');
      var title = document.createElement('div');
      title.textContent = t('pickerTitle');
      title.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-tertiary,#9ca3af);margin:2px 4px 6px;';
      root.appendChild(title);

      var grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(6,1fr);gap:4px;';
      for (var i = 0; i < symbols.length; i++) {
        (function (sym) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = sym.char;
          btn.title = sym.label;
          btn.style.cssText = [
            'height:28px', 'border:1px solid transparent', 'background:transparent',
            'cursor:pointer', 'border-radius:6px', 'font-size:14px',
            'color:var(--dsw-alias-label-primary,#e5e7eb)',
            (opts && opts.selectedKey === sym.key) ? 'border-color:var(--dsw-alias-state-business-primary,#4f8cff)' : '',
          ].join(';');
          btn.addEventListener('click', function (event) {
            event.stopPropagation();
            closePicker();
            if (opts && typeof opts.onPick === 'function') opts.onPick(sym.key);
          });
          grid.appendChild(btn);
        })(symbols[i]);
      }
      root.appendChild(grid);

      var footer = document.createElement('div');
      footer.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
      if (opts && opts.allowClear) {
        var clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.textContent = t('clear');
        clearBtn.style.cssText = 'flex:1;height:26px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.4));background:transparent;color:var(--dsw-alias-label-tertiary,#9ca3af);border-radius:6px;cursor:pointer;font-size:12px;';
        clearBtn.addEventListener('click', function (event) {
          event.stopPropagation();
          closePicker();
          if (opts && typeof opts.onPick === 'function') opts.onPick(null);
        });
        footer.appendChild(clearBtn);
      }
      var newBtn = document.createElement('button');
      newBtn.type = 'button';
      newBtn.textContent = t('newSymbolShort');
      newBtn.style.cssText = 'flex:1;height:26px;border:1px solid var(--dsw-alias-state-business-primary,#4f8cff);background:transparent;color:var(--dsw-alias-state-business-primary,#4f8cff);border-radius:6px;cursor:pointer;font-size:12px;';
      newBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        closePicker();
        openCreateModal(newBtn, function (newKey) {
          if (opts && typeof opts.onPick === 'function') opts.onPick(newKey);
        });
      });
      footer.appendChild(newBtn);
      root.appendChild(footer);

      document.body.appendChild(root);
      var rect = anchor.getBoundingClientRect();
      var panelW = root.offsetWidth;
      var panelH = root.offsetHeight;
      var left = Math.min(rect.left, window.innerWidth - panelW - 8);
      var top = rect.bottom + 4;
      if (top + panelH > window.innerHeight - 8) top = Math.max(8, rect.top - panelH - 4);
      root.style.left = Math.max(8, left) + 'px';
      root.style.top = top + 'px';
      pickerState.root = root;

      pickerState.docDown = function (event) {
        if (root && !root.contains(event.target) && !(modalState.root && modalState.root.contains(event.target))) {
          closePicker();
        }
      };
      setTimeout(function () {
        document.addEventListener('mousedown', pickerState.docDown);
      }, 0);
    }

    function openCreateModal(anchor, onCreated) {
      closeModal();
      var overlay = document.createElement('div');
      overlay.setAttribute('data-owner', 'dsh-icon-marker-modal');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;';
      var panel = document.createElement('div');
      panel.style.cssText = 'width:320px;background:var(--dsw-alias-bg-layer-3,#1f1f1f);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.4));border-radius:12px;padding:14px;color:var(--dsw-alias-label-primary,#e5e7eb);box-shadow:0 12px 32px rgba(0,0,0,0.35);';
      var title = document.createElement('div');
      title.textContent = t('newSymbol');
      title.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:10px;';
      panel.appendChild(title);

      var charLabel = document.createElement('div');
      charLabel.textContent = t('charLabel');
      charLabel.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-tertiary,#9ca3af);margin:8px 0 4px;';
      panel.appendChild(charLabel);
      var charInput = document.createElement('input');
      charInput.type = 'text';
      charInput.style.cssText = 'width:100%;box-sizing:border-box;height:30px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.4));background:var(--dsw-alias-button-elevated-fill,#111);color:inherit;border-radius:6px;padding:0 8px;font-size:14px;';
      panel.appendChild(charInput);

      var labelLabel = document.createElement('div');
      labelLabel.textContent = t('labelLabel');
      labelLabel.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-tertiary,#9ca3af);margin:8px 0 4px;';
      panel.appendChild(labelLabel);
      var labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.style.cssText = charInput.style.cssText;
      panel.appendChild(labelInput);

      var error = document.createElement('div');
      error.style.cssText = 'font-size:12px;color:var(--dsw-alias-state-error-primary,#f87171);margin-top:6px;min-height:16px;';
      panel.appendChild(error);

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:10px;';
      var cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = t('cancel');
      cancelBtn.style.cssText = 'height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,0.4));background:transparent;color:inherit;border-radius:6px;cursor:pointer;font-size:12px;';
      cancelBtn.addEventListener('click', function () { closeModal(); });
      var confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.textContent = t('confirm');
      confirmBtn.style.cssText = 'height:28px;padding:0 12px;border:none;background:var(--dsw-alias-state-business-primary,#4f8cff);color:#fff;border-radius:6px;cursor:pointer;font-size:12px;';
      confirmBtn.addEventListener('click', function () {
        var ch = charInput.value.trim();
        var label = labelInput.value.trim();
        if (graphemeCount(ch) !== 1) {
          error.textContent = t('charError');
          return;
        }
        if (!label) {
          error.textContent = t('labelError');
          return;
        }
        var newKey = addSymbol(ch, label);
        closeModal();
        if (typeof onCreated === 'function') onCreated(newKey);
      });
      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      panel.appendChild(actions);
      overlay.appendChild(panel);
      overlay.addEventListener('mousedown', function (event) {
        if (event.target === overlay) closeModal();
      });
      document.body.appendChild(overlay);
      modalState.root = overlay;
      setTimeout(function () { charInput.focus(); }, 0);
    }

    // ── settings page ───────────────────────────────────────────────────────
    function el(type, props) {
      var args = [type, props];
      for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
      return react.createElement.apply(null, args);
    }

    var styles = {
      section: { width: '100%', maxWidth: 760, color: 'var(--dsw-alias-label-primary)', display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, lineHeight: '20px' },
      heading: { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: '24px' },
      subheading: { margin: '10px 0 0', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      desc: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px', margin: 0 },
      row: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 },
      rowLabel: { flex: 1, minWidth: 0 },
      ruleRow: { display: 'flex', alignItems: 'center', gap: 6 },
      input: { flex: 1, minWidth: 0, height: 28, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-button-elevated-fill)', color: 'inherit', borderRadius: 6, padding: '0 8px', fontSize: 12 },
      flagsInput: { width: 48, height: 28, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-button-elevated-fill)', color: 'inherit', borderRadius: 6, padding: '0 8px', fontSize: 12 },
      symbolBtn: { width: 30, height: 28, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-button-elevated-fill)', color: 'inherit', borderRadius: 6, cursor: 'pointer', fontSize: 14 },
      primaryBtn: { alignSelf: 'flex-start', height: 28, padding: '0 12px', border: '1px solid var(--dsw-alias-state-business-primary)', background: 'transparent', color: 'var(--dsw-alias-state-business-primary)', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
      dangerBtn: { width: 28, height: 28, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
      toggleOn: { height: 28, padding: '0 12px', border: '1px solid var(--dsw-alias-state-business-primary)', background: 'var(--dsw-alias-state-business-primary)', color: '#fff', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
      toggleOff: { height: 28, padding: '0 12px', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
      chipWrap: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-module-platform)', borderRadius: 999, padding: '2px 8px', fontSize: 13 },
      chipDelete: { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 },
    };

    function StateRow(props) {
      var def = props.def;
      var symbol = props.symbol;
      return el('div', { key: def.key, style: styles.row },
        el('span', { style: styles.rowLabel }, t('state.' + def.key)),
        el('button', {
          type: 'button',
          style: styles.symbolBtn,
          title: symbol ? symbol.label : t('placeholderTitle'),
          onClick: function (event) {
            event.stopPropagation();
            openSymbolPicker(event.currentTarget, {
              allowClear: true,
              selectedKey: symbol ? symbol.key : null,
              onPick: function (key) { writeStateSymbol(def.key, key); },
            });
          },
        }, symbol ? symbol.char : '+'));
    }

    function RuleRow(props) {
      var rule = props.rule;
      var symbol = props.symbol;
      return el('div', { key: rule.id, style: styles.ruleRow },
        el('input', {
          style: styles.input,
          value: rule.pattern || '',
          placeholder: t('patternPlaceholder'),
          onChange: function (event) { props.onChange(rule.id, 'pattern', event.target.value); },
        }),
        el('button', {
          type: 'button',
          style: styles.symbolBtn,
          title: symbol ? symbol.label : t('placeholderTitle'),
          onClick: function (event) {
            event.stopPropagation();
            openSymbolPicker(event.currentTarget, {
              allowClear: true,
              selectedKey: symbol ? symbol.key : null,
              onPick: function (key) { props.onPick(rule.id, key); },
            });
          },
        }, symbol ? symbol.char : '+'),
        el('button', { type: 'button', style: styles.dangerBtn, onClick: function () { props.onRemove(rule.id); } }, '×'));
    }

    function SymbolChip(props) {
      var sym = props.symbol;
      return el('span', { key: sym.key, style: styles.chip, title: sym.label },
        sym.char,
        !sym.builtin ? el('button', {
          type: 'button',
          style: styles.chipDelete,
          title: t('deleteRule'),
          onClick: function () { removeCustomSymbol(sym.key); },
        }, '×') : null);
    }

    function SettingsSection(props) {
      var forceState = react.useReducer(function (x) { return x + 1; }, 0);
      var force = forceState[1];

      react.useEffect(function () {
        var offScope = scopeRef.scope ? scopeRef.scope.subscribe(force) : null;
        var offSessions = sessionsRef.list ? sessionsRef.list.subscribe(force) : null;
        return function () {
          if (offScope) offScope();
          if (offSessions) offSessions();
        };
      }, []);

      var snap = scopeRef.scope ? scopeRef.scope.getSnapshot() : null;
      if (!snap || snap.status === 'idle') {
        return el('div', { style: styles.section }, el('p', { style: styles.desc }, t('loading')));
      }
      if (snap.status !== 'ready' || !snap.value) {
        return el('div', { style: styles.section }, el('p', { style: styles.desc }, t('error')));
      }

      var value = snap.value;
      var symbols = resolveSymbols(value);
      var stateSymbols = value.stateSymbols || {};
      var autoRules = value.autoRules || [];
      var hideStatus = !!value.hideStatus;
      var customs = (value.symbols && Array.isArray(value.symbols)) ? value.symbols : [];

      var stateRows = STATE_DEFS.map(function (def) {
        var key = stateSymbols[def.key];
        var sym = key ? findSymbol(symbols, key) : null;
        return el(StateRow, { key: def.key, def: def, symbol: sym });
      });

      function changeRule(id, field, val) {
        var next = autoRules.map(function (rule) {
          if (rule.id !== id) return rule;
          var updated = Object.assign({}, rule);
          updated[field] = val;
          return updated;
        });
        writeAutoRules(next);
      }

      function pickRuleSymbol(id, key) {
        var next = autoRules.map(function (rule) {
          if (rule.id !== id) return rule;
          var updated = Object.assign({}, rule);
          updated.symbolKey = key || '';
          return updated;
        });
        writeAutoRules(next);
      }

      function removeRule(id) {
        writeAutoRules(autoRules.filter(function (rule) { return rule.id !== id; }));
      }

      function addRule() {
        var id = 'rule-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        writeAutoRules(autoRules.concat([{ id: id, pattern: '', flags: 'i', symbolKey: '' }]));
      }

      var ruleRows = autoRules.map(function (rule) {
        var sym = rule.symbolKey ? findSymbol(symbols, rule.symbolKey) : null;
        return el(RuleRow, {
          key: rule.id,
          rule: rule,
          symbol: sym,
          onChange: changeRule,
          onPick: pickRuleSymbol,
          onRemove: removeRule,
        });
      });

      var symbolChips = symbols.map(function (sym) {
        return el(SymbolChip, { key: sym.key, symbol: sym });
      });

      return el('div', { style: styles.section },
        el('h3', { key: 'heading', style: styles.heading }, t('settingsLabel')),
        el('div', { key: 'hide', style: styles.row },
          el('span', { style: styles.rowLabel }, t('hideStatusLabel')),
          el('button', {
            type: 'button',
            style: hideStatus ? styles.toggleOn : styles.toggleOff,
            onClick: function () { writeHideStatus(!hideStatus); },
          }, hideStatus ? t('on') : t('off'))),
        el('h4', { key: 'stateTitle', style: styles.subheading }, t('stateMappingTitle')),
        stateRows,
        el('h4', { key: 'ruleTitle', style: styles.subheading }, t('rulesTitle')),
        ruleRows,
        el('button', { key: 'addRule', type: 'button', style: styles.primaryBtn, onClick: addRule }, t('addRule')),
        el('h4', { key: 'symbolTitle', style: styles.subheading }, t('symbolsTitle')),
        el('div', { key: 'symbols', style: styles.chipWrap }, symbolChips),
        el('button', {
          key: 'addSymbol',
          type: 'button',
          style: styles.primaryBtn,
          onClick: function (event) {
            openCreateModal(event.currentTarget, function () { /* added; settings subscription re-renders */ });
          },
        }, t('newSymbol')));
    }

    // ── apply ───────────────────────────────────────────────────────────────
    var NS = 'dsh-icon-marker';
    var inject = ['slots', 'settingsScope', 'sessions', 'locale'];

    function renderAll() {
      renderRows();
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'dsh-icon-marker: dictionaries');
      var tBound = ctx.locale.bind(NS);
      tRef.t = function (key) { return tBound(key); };

      var scope = ctx.settingsScope.bind({ namespace: NS });
      scopeRef.scope = scope;
      sessionsRef.list = ctx.sessions.list;
      sessionsRef.service = ctx.sessions;

      var disposers = [];
      disposers.push(scope.subscribe(function () {
        renderAll();
        rescanCurrentSession();
      }));
      disposers.push(ctx.sessions.list.subscribe(function () {
        renderAll();
        syncAutoHook();
      }));
      disposers.push(installRowObserver());
      ctx.effect(function () {
        return function () {
          for (var i = 0; i < disposers.length; i++) disposers[i]();
          if (autoHook.dispose) {
            autoHook.dispose();
            autoHook.dispose = null;
          }
          removeOwnRows();
          closePicker();
          closeModal();
        };
      }, 'dsh-icon-marker: main');

      syncAutoHook();

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'icon-marker',
          order: 30,
          label: function () { return tRef.t('settingsLabel'); },
        }, SettingsSection);
      });
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
