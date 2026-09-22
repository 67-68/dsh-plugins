// dsh-trajectory-notes · browser 半（checklist-3）
//
// 在「对话 / 轨迹」旁边注册第三个同级 tab「轨迹摘要」：
//   - 列表：与原生轨迹一一对应的 turn 条目，每条展示模型摘要（无摘要标"未总结"）
//   - 详情：点条目进入，看用户输入 / Agent 回复 / 工具序列 / 摘要全文
//   - 「跳转轨迹页面」按钮：优先走 slot 传进来的 setView('trajectory')，
//     拿不到时回退到点原生 tab 的 DOM 兜底（抄 mode-gate 的 activateChatView）
//   - 「总结」按钮：调 host Remote summarize，落盘后刷新
//
// 数据全部走 host 的 trajectoryNotes Remote，不直读会话日志。
// 写法约束：无 JSX、无构建步骤，React.createElement + .js，与 dsh-mode-gate /
// dsh-icon-marker 同款 ModuleLoader 封装。

window.__ModuleLoader__.load({
  id: "dsh-trajectory-notes",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");

    // ── i18n ─────────────────────────────────────────────────────────────
    var NS = "trajectory-notes";

    var zh = {
      tab: "轨迹摘要",
      loading: "正在读取轨迹摘要…",
      loadError: "读取失败",
      retry: "重试",
      refresh: "刷新",
      summarizeAll: "总结未总结的条目",
      summarizeOne: "总结本条",
      summarizing: "总结中…",
      backToList: "返回列表",
      jumpToTrajectory: "跳转轨迹页面",
      deleteNote: "删除摘要",
      deleting: "删除中…",
      noEntries: "这个会话还没有轨迹条目。",
      noSummary: "未总结",
      userInput: "用户输入",
      agentReply: "Agent 回复",
      toolCalls: "工具调用",
      summary: "模型摘要",
      savedAt: "摘要时间",
      failed: "失败",
      completed: "完成",
      aborted: "中断",
      untitled: "无标题",
      unclosed: "未收口",
      detailTitle: "轨迹条目",
      confirmDelete: "确定删除这条摘要吗？（只删摘要，不动轨迹）",
      emptyUser: "（本轮没有人类输入）",
      emptyAssistant: "（无文本回复）",
      ops: "操作",
    };

    var en = {
      tab: "Trajectory Notes",
      loading: "Loading trajectory notes…",
      loadError: "Failed to load",
      retry: "Retry",
      refresh: "Refresh",
      summarizeAll: "Summarize unsummarized entries",
      summarizeOne: "Summarize this entry",
      summarizing: "Summarizing…",
      backToList: "Back to list",
      jumpToTrajectory: "Open trajectory page",
      deleteNote: "Delete note",
      deleting: "Deleting…",
      noEntries: "No trajectory entries in this session yet.",
      noSummary: "Not summarized",
      userInput: "User input",
      agentReply: "Agent reply",
      toolCalls: "Tool calls",
      summary: "Model summary",
      savedAt: "Saved at",
      failed: "failed",
      completed: "completed",
      aborted: "aborted",
      untitled: "Untitled",
      unclosed: "open",
      detailTitle: "Trajectory entry",
      confirmDelete: "Delete this note? (Only the note is deleted, never the trajectory.)",
      emptyUser: "(No human input in this turn)",
      emptyAssistant: "(No text reply)",
      ops: "Actions",
    };

    // ── Remote face（与 host 的 TrajectoryNotesGateway 对应） ──────────────
    function makeCodec(kind) {
      return {
        mode: "strict",
        typeSymbol: "dsh-trajectory-notes/types#" + kind,
        schema: { parse: function (value) { return value; } },
      };
    }

    function remoteArgsDescriptor(method) {
      return {
        id: "dsh-trajectory-notes#trajectoryNotes/" + method,
        service: "trajectoryNotes",
        namespace: "trajectoryNotes",
        method: method,
        invocation: { kind: "direct" },
        parameters: [{ name: "args", wire: "args", source: "json", codec: makeCodec(method + "Args") }],
        result: makeCodec(method + "Result"),
      };
    }

    var TYPERT_REMOTE = {
      package: "dsh-trajectory-notes",
      descriptors: [
        remoteArgsDescriptor("listEntries"),
        remoteArgsDescriptor("getEntry"),
        remoteArgsDescriptor("summarize"),
        remoteArgsDescriptor("deleteNote"),
      ],
    };

    var inject = ["slots", "locale", "sessions", "remote"];

    // ── 样式（主题 token，抄 repo 内其它 client） ───────────────────────────
    var styles = {
      page: { height: "100%", width: "100%", overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 },
      inner: { width: "100%", maxWidth: 760, display: "flex", flexDirection: "column", gap: 10 },
      title: { color: "var(--dsw-alias-label-primary)", fontSize: 16, fontWeight: 600, lineHeight: "24px" },
      sub: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "18px" },
      toolbar: { display: "flex", gap: 8, flexWrap: "wrap" },
      button: { font: "inherit", fontSize: 12, lineHeight: "18px", padding: "4px 12px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))", background: "var(--dsw-alias-bg-layer-3, transparent)", color: "var(--dsw-alias-label-primary, inherit)", cursor: "pointer" },
      buttonPrimary: { font: "inherit", fontSize: 12, lineHeight: "18px", padding: "4px 12px", borderRadius: 6, border: "1px solid transparent", background: "var(--dsw-alias-state-info-primary, #2f6fed)", color: "#fff", cursor: "pointer" },
      buttonDanger: { font: "inherit", fontSize: 12, lineHeight: "18px", padding: "4px 12px", borderRadius: 6, border: "1px solid var(--dsw-alias-state-error-primary, #e5484d)", background: "transparent", color: "var(--dsw-alias-state-error-primary, #e5484d)", cursor: "pointer" },
      buttonDisabled: { opacity: 0.5, cursor: "default" },
      card: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: 10, padding: "10px 14px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 4 },
      cardHead: { display: "flex", alignItems: "center", gap: 8 },
      cardTitle: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      badge: { whiteSpace: "nowrap", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", borderRadius: 999, padding: "1px 8px", fontSize: 11, lineHeight: "17px" },
      badgeWarn: { whiteSpace: "nowrap", color: "var(--dsw-alias-state-error-primary)", border: "1px solid var(--dsw-alias-state-error-primary)", borderRadius: 999, padding: "1px 8px", fontSize: 11, lineHeight: "17px" },
      summary: { fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-primary)", whiteSpace: "pre-wrap" },
      noSummary: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
      meta: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" },
      error: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 },
      sectionTitle: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-secondary)", marginTop: 8 },
      pre: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-primary)", whiteSpace: "pre-wrap", margin: 0 },
    };

    function mergeStyle(base, extra) {
      var out = {};
      for (var k in base) out[k] = base[k];
      for (var k2 in extra) out[k2] = extra[k2];
      return out;
    }

    // ── 会话 id：取自 sessions.list 快照的 current（抄 mode-gate useWorkflows） ─
    function useSessionId(sessions) {
      var list = react.useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot, sessions.list.getSnapshot);
      return list && typeof list.current === "string" ? list.current : null;
    }

    // ── 跳转原生轨迹页 ────────────────────────────────────────────────────
    // 主路径：slot 传进来的 setView('trajectory')；兜底：点原生 tab。
    // 原生 tab 叫「轨迹」，自己这个 tab 叫「轨迹摘要」，所以点 tab 时必须
    // 排除含「摘要」的那个（中英文都处理）。
    function jumpToTrajectoryView(setView) {
      if (typeof setView === "function") {
        try {
          setView("trajectory");
          return;
        } catch (_err) {
          /* 掉到 DOM 兜底 */
        }
      }
      var click = function () {
        if (typeof document === "undefined") return;
        var tabs = document.querySelectorAll('[role="tab"]');
        for (var i = 0; i < tabs.length; i++) {
          var text = tabs[i].textContent || "";
          var isTrajectory = text.indexOf("轨迹") >= 0 || text.toLowerCase().indexOf("trajectory") >= 0;
          var isOwn = text.indexOf("摘要") >= 0 || text.toLowerCase().indexOf("notes") >= 0;
          if (isTrajectory && !isOwn) {
            tabs[i].click();
            return;
          }
        }
      };
      click();
      for (var d = 0; d < [150, 500, 1200].length; d++) {
        (function (delay) { setTimeout(click, delay); })([150, 500, 1200][d]);
      }
    }

    function formatTime(ms, t) {
      if (!ms) return "";
      try {
        return new Date(ms).toLocaleString();
      } catch (_err) {
        return String(ms);
      }
    }

    function endReasonLabel(kind, t) {
      if (kind === "completed") return t("completed");
      if (kind === "aborted") return t("aborted");
      return kind || "";
    }

    // ── 列表项 ────────────────────────────────────────────────────────────
    function EntryRow(props) {
      var entry = props.entry;
      var t = props.t;
      var onOpen = props.onOpen;
      var onSummarize = props.onSummarize;
      var busy = props.busy;
      var stats = "step " + entry.stepCount + " · " + t("toolCalls") + " " + entry.toolCallCount + " 次";
      if (entry.errorCount) stats += "(" + entry.errorCount + " " + t("failed") + ")";
      var reason = endReasonLabel(entry.endReasonKind, t);
      if (reason) stats += " · " + reason;
      return react.createElement("div", {
        style: styles.card,
        onClick: function () { onOpen(entry.turn); },
        role: "button",
        tabIndex: 0,
        onKeyDown: function (e) { if (e.key === "Enter") onOpen(entry.turn); },
      },
        react.createElement("div", { style: styles.cardHead },
          react.createElement("span", { style: styles.cardTitle }, "turn " + entry.turn),
          entry.hasNote
            ? react.createElement("span", { style: styles.badge }, t("summary"))
            : react.createElement("span", { style: styles.badgeWarn }, t("noSummary")),
          react.createElement("span", { style: styles.meta }, "seq " + entry.startSeq + "…" + (entry.endSeq == null ? "?" : entry.endSeq)),
        ),
        entry.hasNote
          ? react.createElement("div", { style: styles.summary }, entry.summary)
          : react.createElement("div", { style: styles.noSummary },
            (entry.userPreview || t("emptyUser")).slice(0, 160),
            " ",
            react.createElement("button", {
              style: mergeStyle(styles.button, busy ? styles.buttonDisabled : {}),
              disabled: busy,
              onClick: function (e) { e.stopPropagation(); onSummarize(entry.turn); },
            }, busy ? t("summarizing") : t("summarizeOne")),
          ),
        react.createElement("div", { style: styles.meta }, stats),
      );
    }

    // ── 主视图（列表 / 详情二态） ──────────────────────────────────────────
    function TrajectoryNotesView(props) {
      var sessions = props.sessions;
      var api = props.api;
      var setView = props.setView;
      var t = props.t;
      var sessionId = useSessionId(sessions);

      var _useStateList = react.useState(null);
      var data = _useStateList[0];
      var setData = _useStateList[1];
      var _useStateLoading = react.useState(false);
      var loading = _useStateLoading[0];
      var setLoading = _useStateLoading[1];
      var _useStateError = react.useState("");
      var error = _useStateError[0];
      var setError = _useStateError[1];
      var _useStateDetail = react.useState(null);
      var detailTurn = _useStateDetail[0];
      var setDetailTurn = _useStateDetail[1];
      var _useStateDetailData = react.useState(null);
      var detail = _useStateDetailData[0];
      var setDetail = _useStateDetailData[1];
      var _useStateBusy = react.useState(false);
      var busy = _useStateBusy[0];
      var setBusy = _useStateBusy[1];

      var refresh = react.useCallback(function () {
        if (!sessionId) return Promise.resolve();
        setLoading(true);
        setError("");
        return api().listEntries({ sessionId: sessionId, limit: 200 }).then(function (result) {
          if (result && result.ok && result.value) {
            setData(result.value);
          } else {
            setError(t("loadError"));
          }
        }).catch(function (err) {
          setError(t("loadError") + ": " + String((err && err.message) || err));
        }).finally(function () {
          setLoading(false);
        });
      }, [sessionId, api, t]);

      react.useEffect(function () {
        setData(null);
        setDetailTurn(null);
        setDetail(null);
        refresh();
      }, [sessionId, refresh]);

      var openDetail = function (turn) {
        if (!sessionId) return;
        setDetailTurn(turn);
        setDetail(null);
        setError("");
        api().getEntry({ sessionId: sessionId, turn: turn }).then(function (result) {
          if (result && result.ok && result.value) setDetail(result.value);
          else setError(t("loadError"));
        }).catch(function (err) {
          setError(t("loadError") + ": " + String((err && err.message) || err));
        });
      };

      var summarizeTurns = function (turns) {
        if (!sessionId || busy) return Promise.resolve();
        setBusy(true);
        setError("");
        return api().summarize({ sessionId: sessionId, turns: turns }).then(function (result) {
          if (!(result && result.ok)) setError(t("loadError"));
        }).catch(function (err) {
          setError(t("loadError") + ": " + String((err && err.message) || err));
        }).finally(function () {
          setBusy(false);
          return refresh().then(function () {
            if (detailTurn != null) openDetail(detailTurn);
          });
        });
      };

      var deleteCurrentNote = function () {
        if (!sessionId || detailTurn == null || busy) return;
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          if (!window.confirm(t("confirmDelete"))) return;
        }
        setBusy(true);
        api().deleteNote({ sessionId: sessionId, turn: detailTurn }).then(function () {
          setDetailTurn(null);
          setDetail(null);
        }).catch(function (err) {
          setError(t("loadError") + ": " + String((err && err.message) || err));
        }).finally(function () {
          setBusy(false);
          refresh();
        });
      };

      var summarizeMissing = function () {
        if (!data || !Array.isArray(data.entries)) return Promise.resolve();
        var missing = data.entries.filter(function (e) { return !e.hasNote; }).map(function (e) { return e.turn; });
        if (!missing.length) return Promise.resolve();
        return summarizeTurns(missing.slice(0, 20));
      };

      // ── 详情屏 ──
      if (detailTurn != null) {
        return react.createElement("div", { style: styles.page },
          react.createElement("div", { style: styles.inner },
            react.createElement("div", { style: styles.toolbar },
              react.createElement("button", { style: styles.button, onClick: function () { setDetailTurn(null); setDetail(null); } }, "← " + t("backToList")),
              react.createElement("button", { style: styles.buttonPrimary, onClick: function () { jumpToTrajectoryView(setView); } }, t("jumpToTrajectory")),
            ),
            react.createElement("div", { style: styles.title }, t("detailTitle") + " · turn " + detailTurn),
            error ? react.createElement("div", { style: styles.error }, error) : null,
            !detail ? react.createElement("div", { style: styles.sub }, t("loading")) : react.createElement(react.Fragment, null,
              react.createElement("div", { style: styles.sectionTitle }, t("summary")),
              detail.summary
                ? react.createElement("div", { style: styles.summary }, detail.summary)
                : react.createElement("div", { style: styles.noSummary }, t("noSummary")),
              react.createElement("div", { style: styles.toolbar },
                react.createElement("button", {
                  style: mergeStyle(styles.button, busy ? styles.buttonDisabled : {}),
                  disabled: busy,
                  onClick: function () { summarizeTurns([detailTurn]); },
                }, busy ? t("summarizing") : t("summarizeOne")),
                detail.summary ? react.createElement("button", {
                  style: mergeStyle(styles.buttonDanger, busy ? styles.buttonDisabled : {}),
                  disabled: busy,
                  onClick: deleteCurrentNote,
                }, busy ? t("deleting") : t("deleteNote")) : null,
              ),
              react.createElement("div", { style: styles.sectionTitle }, t("userInput")),
              (detail.userTexts && detail.userTexts.length
                ? detail.userTexts.map(function (u, i) {
                  return react.createElement("p", { key: "u" + i, style: styles.pre }, u.text + (u.truncated ? " …" : ""));
                })
                : react.createElement("div", { style: styles.noSummary }, t("emptyUser"))),
              react.createElement("div", { style: styles.sectionTitle }, t("agentReply")),
              (detail.assistantTexts && detail.assistantTexts.length
                ? detail.assistantTexts.slice(0, 3).map(function (a, i) {
                  return react.createElement("p", { key: "a" + i, style: styles.pre }, a.text.slice(0, 800) + (a.text.length > 800 ? " …" : ""));
                })
                : react.createElement("div", { style: styles.noSummary }, t("emptyAssistant"))),
              react.createElement("div", { style: styles.sectionTitle }, t("toolCalls") + " (" + (detail.toolCalls ? detail.toolCalls.length : 0) + ")"),
              react.createElement("div", { style: styles.meta },
                (detail.toolCalls || []).slice(0, 20).map(function (c) { return c.name + (c.isError ? " [x]" : ""); }).join(" · ") || "—"),
              detail.savedAt ? react.createElement("div", { style: styles.meta }, t("savedAt") + ": " + formatTime(detail.savedAt, t)) : null,
            ),
          ),
        );
      }

      // ── 列表屏 ──
      var entries = data && Array.isArray(data.entries) ? data.entries : [];
      var missingCount = entries.filter(function (e) { return !e.hasNote; }).length;
      return react.createElement("div", { style: styles.page },
        react.createElement("div", { style: styles.inner },
          react.createElement("div", { style: styles.title }, t("tab")),
          react.createElement("div", { style: styles.sub },
            data ? ((data.title || t("untitled")) + " · " + data.turnCount + " turns · " + entries.filter(function (e) { return e.hasNote; }).length + "/" + entries.length) : (sessionId || "")),
          react.createElement("div", { style: styles.toolbar },
            react.createElement("button", { style: styles.button, onClick: refresh, disabled: loading }, t("refresh")),
            missingCount > 0 ? react.createElement("button", {
              style: mergeStyle(styles.buttonPrimary, busy ? styles.buttonDisabled : {}),
              disabled: busy,
              onClick: summarizeMissing,
            }, busy ? t("summarizing") : t("summarizeAll") + " (" + missingCount + ")") : null,
          ),
          error ? react.createElement("div", { style: styles.error },
            error, " ",
            react.createElement("button", { style: styles.button, onClick: refresh }, t("retry"))) : null,
          loading && !data ? react.createElement("div", { style: styles.sub }, t("loading")) : null,
          (!loading && data && entries.length === 0) ? react.createElement("div", { style: styles.sub }, t("noEntries")) : null,
          entries.map(function (entry) {
            return react.createElement(EntryRow, {
              key: "turn-" + entry.turn,
              entry: entry,
              t: t,
              busy: busy,
              onOpen: openDetail,
              onSummarize: function (turn) { summarizeTurns([turn]); },
            });
          }),
        ),
      );
    }

    // ── 插件入口 ─────────────────────────────────────────────────────────
    async function apply(ctx) {
      var disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
      ctx.effect(function () { return function () { disposeRemote(); }; }, "dsh-trajectory-notes: remote face");
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-trajectory-notes: dictionaries");
      var t = ctx.locale.bind(NS);
      var api = function () {
        var remote = ctx.get("remote.trajectoryNotes");
        if (remote === undefined) throw new Error("remote.trajectoryNotes service is not mounted");
        return remote;
      };

      // 与「对话 / 轨迹」同级的第三个 tab。order 放在原生轨迹（10）之后。
      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register({
          name: "conversation.view",
          id: "trajectory-notes",
          order: 20,
          locale: NS,
          label: function () { return t("tab"); },
          inject: function (sessionId, actions) {
            return {
              sessions: ctx.get("sessions"),
              api: api,
              t: t,
              setView: actions && actions.setView,
            };
          },
        }, TrajectoryNotesView);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
