window.__ModuleLoader__.load({
	id: "dsh-mode-gate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ── locales ─────────────────────────────────────────────────────────────
		const zh = {
			tab: "模式门禁",
			title: "dsh-mode-gate 模式权限",
			desc: "展示各模式的权限定义，并维护 bash 禁止命令列表。",
			modeReadOnly: "READ_ONLY",
			modePlanOnly: "PLAN_ONLY",
			modeWriteEnabled: "WRITE_ENABLED",
			permReadOnly: "只读工具；bash 仅允许只读命令；禁止写文件",
			permPlanOnly: "只读工具 + 规划工具（todo_write / ask_user_question / exit_plan_mode）",
			permWriteEnabled: "允许写工具；危险 bash 命令仍需人工授权",
			modeLabel: "模式",
			permLabel: "权限",
			targetLabel: "当前 Target / 模式",
			noTarget: "（尚未声明）",
			denyTitle: "禁止的 bash 命令",
			denyDesc: "命中以下命令时直接拒绝执行，原因会显示给 agent。一个条目可以包含多个命令。",
			denyCommands: "命令",
			denyReason: "原因",
			denyCommandsPlaceholder: "逗号分隔多个命令，如 curl, wget",
			denyReasonPlaceholder: "禁止原因",
			add: "添加",
			delete: "删除",
			save: "保存",
			loadFailed: "读取禁止列表失败",
			saveFailed: "保存禁止列表失败",
		};
		const en = {
			tab: "Mode Gate",
			title: "dsh-mode-gate permissions",
			desc: "Shows the permission definition of each mode and maintains the bash deny-list.",
			modeReadOnly: "READ_ONLY",
			modePlanOnly: "PLAN_ONLY",
			modeWriteEnabled: "WRITE_ENABLED",
			permReadOnly: "Read-only tools; bash read-only commands only; no file writes",
			permPlanOnly: "Read-only tools + planning tools (todo_write / ask_user_question / exit_plan_mode)",
			permWriteEnabled: "Write tools allowed; dangerous bash commands require approval",
			modeLabel: "Mode",
			permLabel: "Permissions",
			targetLabel: "Current target / mode",
			noTarget: "(not declared yet)",
			denyTitle: "Denied bash commands",
			denyDesc: "Matching commands are rejected immediately and the reason is shown to the agent. One entry can contain multiple commands.",
			denyCommands: "Commands",
			denyReason: "Reason",
			denyCommandsPlaceholder: "Comma separated commands, e.g. curl, wget",
			denyReasonPlaceholder: "Deny reason",
			add: "Add",
			delete: "Delete",
			save: "Save",
			loadFailed: "Failed to load deny-list",
			saveFailed: "Failed to save deny-list",
		};

		const MODES = ["READ_ONLY", "PLAN_ONLY", "WRITE_ENABLED"];

		/** Read the durable mode-gate state for the current session via the Remote service. */
		function useModeGateState(sessions, api) {
			const list = react.useSyncExternalStore(
				sessions.list.subscribe,
				sessions.list.getSnapshot,
				sessions.list.getSnapshot
			);
			const sessionId = list.current;
			const [state, setState] = react.useState({ mode: "READ_ONLY", target: null });
			const sessionKey = typeof sessionId === "string" ? sessionId : "";

			react.useEffect(() => {
				let current = true;
				let timer;
				const refresh = async () => {
					if (sessionKey === "") {
						if (current) setState({ mode: "READ_ONLY", target: null });
						return;
					}
					try {
						const result = await api().getState({ sessionId: sessionKey });
						if (!current) return;
						if (result && result.ok && result.value) {
							setState(result.value);
						} else if (current) {
							setState({ mode: "READ_ONLY", target: null });
						}
					} catch (_err) {
						if (current) setState({ mode: "READ_ONLY", target: null });
					}
				};
				refresh();
				timer = setInterval(refresh, 2000);
				return () => { current = false; clearInterval(timer); };
			}, [sessionKey, api]);

			return state;
		}

		/** Read and update the bash deny-list through the Remote service. */
		function useBashDenyList(api) {
			const [entries, setEntries] = react.useState([]);
			const [error, setError] = react.useState("");

			const refresh = react.useCallback(async () => {
				try {
					const result = await api().getBashDenyList();
					if (result && result.ok && result.value && Array.isArray(result.value.entries)) {
						setEntries(result.value.entries);
					} else {
						setEntries([]);
					}
				} catch (err) {
					setError(String((err && err.message) || err));
				}
			}, [api]);

			react.useEffect(() => { refresh(); }, [refresh]);

			const save = react.useCallback(async (nextEntries) => {
				try {
					const result = await api().setBashDenyList({ entries: nextEntries });
					if (result && result.ok && result.value && Array.isArray(result.value.entries)) {
						setEntries(result.value.entries);
						setError("");
					} else {
						setError("saveFailed");
					}
				} catch (err) {
					setError(String((err && err.message) || err));
				}
			}, [api]);

			return { entries, error, refresh, save };
		}

		const MODE_ROWS = [
			["modeReadOnly", "permReadOnly"],
			["modePlanOnly", "permPlanOnly"],
			["modeWriteEnabled", "permWriteEnabled"],
		];

		const styles = {
			footer: { display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", color: "var(--dsw-alias-label-secondary)", fontSize: 12, minWidth: 0 },
			badge: { whiteSpace: "nowrap", background: "var(--dsw-alias-bg-module-platform)", borderRadius: 999, padding: "1px 8px", fontSize: 11, lineHeight: "17px" },
			target: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-primary)" },
			section: { width: "100%", maxWidth: 760, color: "var(--dsw-alias-label-primary)", display: "flex", flexDirection: "column", gap: 14 },
			desc: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: "20px", margin: 0 },
			table: { borderCollapse: "collapse", width: "100%", fontSize: 13, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, overflow: "hidden" },
			th: { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)", fontWeight: 600 },
			td: { padding: "8px 10px", borderBottom: "1px solid var(--dsw-alias-border-l2)", verticalAlign: "top" },
			code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "var(--dsw-alias-label-primary)" },
			denyHead: { margin: "4px 0 0", fontSize: 15, fontWeight: 600 },
			input: { width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: 13, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)" },
			button: { padding: "6px 12px", fontSize: 13, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)", cursor: "pointer" },
			addRow: { display: "flex", gap: 8 },
			error: { color: "var(--dsw-alias-label-danger, #e5484d)", fontSize: 13, margin: 0 },
		};

		/** Left sidebar footer badge: current mode + declared target. */
		function ModeGateFooterAction(props) {
			const { sessions, api, t, wide } = props;
			const state = useModeGateState(sessions, api);
			const title = `${t("modeLabel")}: ${state.mode} / ${t("targetLabel")}: ${state.target ? state.target.target : t("noTarget")}`;
			if (!wide) return react.createElement("span", { style: styles.badge, title }, state.mode);
			return react.createElement("div", { style: styles.footer },
				react.createElement("span", { style: styles.badge }, state.mode),
				react.createElement("span", { style: styles.target }, state.target ? state.target.target : t("noTarget")),
			);
		}

		/** Static settings tab: show mode definitions and permissions. */
		function ModeGateSettingsTab(props) {
			const { t, api } = props;
			const deny = useBashDenyList(api);
			const [draft, setDraft] = react.useState([]);
			const [newCommands, setNewCommands] = react.useState("");
			const [newReason, setNewReason] = react.useState("");

			react.useEffect(() => {
				setDraft((deny.entries || []).map((entry) => ({ ...entry, commands: [...entry.commands] })));
			}, [deny.entries]);

			const updateCommands = (idx, value) => setDraft((prev) => prev.map((entry, i) => (
				i === idx ? { ...entry, commands: value.split(/[\s,]+/).filter(Boolean) } : entry
			)));
			const updateReason = (idx, value) => setDraft((prev) => prev.map((entry, i) => (
				i === idx ? { ...entry, reason: value } : entry
			)));

			const saveAll = async () => { await deny.save(draft); };
			const deleteEntry = async (idx) => {
				const next = draft.filter((_, i) => i !== idx);
				setDraft(next);
				await deny.save(next);
			};
			const addEntry = async () => {
				const commands = newCommands.split(/[\s,]+/).filter(Boolean);
				if (commands.length === 0) return;
				const next = [...draft, { id: `deny-${Date.now()}`, commands, reason: newReason.trim() }];
				setDraft(next);
				setNewCommands("");
				setNewReason("");
				await deny.save(next);
			};

			const head = react.createElement("p", { style: styles.desc }, t("desc"));
			const rows = MODE_ROWS.map(([modeKey, permKey]) => react.createElement("tr", { key: modeKey },
				react.createElement("td", { style: styles.td }, react.createElement("code", { style: styles.code }, t(modeKey))),
				react.createElement("td", { style: styles.td }, t(permKey)),
			));
			const table = react.createElement("table", { style: styles.table },
				react.createElement("thead", null,
					react.createElement("tr", null,
						react.createElement("th", { style: styles.th }, t("modeLabel")),
						react.createElement("th", { style: styles.th }, t("permLabel")),
					)
				),
				react.createElement("tbody", null, rows),
			);

			const denyHead = react.createElement("h3", { style: styles.denyHead }, t("denyTitle"));
			const denyDesc = react.createElement("p", { style: styles.desc }, t("denyDesc"));
			const denyRows = draft.map((entry, idx) => react.createElement("tr", { key: entry.id || idx },
				react.createElement("td", { style: styles.td },
					react.createElement("input", { style: styles.input, value: entry.commands.join(', '), onChange: (e) => updateCommands(idx, e.target.value) })),
				react.createElement("td", { style: styles.td },
					react.createElement("input", { style: styles.input, value: entry.reason || '', onChange: (e) => updateReason(idx, e.target.value) })),
				react.createElement("td", { style: styles.td },
					react.createElement("button", { style: styles.button, onClick: () => deleteEntry(idx) }, t("delete"))),
			));
			const denyTable = react.createElement("table", { style: styles.table },
				react.createElement("thead", null,
					react.createElement("tr", null,
						react.createElement("th", { style: styles.th }, t("denyCommands")),
						react.createElement("th", { style: styles.th }, t("denyReason")),
						react.createElement("th", { style: styles.th }, ""),
					)
				),
				react.createElement("tbody", null, denyRows),
			);
			const addRow = react.createElement("div", { style: styles.addRow },
				react.createElement("input", { style: styles.input, placeholder: t("denyCommandsPlaceholder"), value: newCommands, onChange: (e) => setNewCommands(e.target.value) }),
				react.createElement("input", { style: styles.input, placeholder: t("denyReasonPlaceholder"), value: newReason, onChange: (e) => setNewReason(e.target.value) }),
				react.createElement("button", { style: styles.button, onClick: addEntry }, t("add")),
			);
			const saveButton = react.createElement("button", { style: styles.button, onClick: saveAll }, t("save"));
			const errorLine = deny.error ? react.createElement("p", { style: styles.error }, typeof deny.error === "string" && deny.error !== "saveFailed" ? deny.error : t(deny.error === "saveFailed" ? "saveFailed" : "loadFailed")) : null;

			return react.createElement("div", { style: styles.section }, head, table, denyHead, denyDesc, denyTable, addRow, saveButton, errorLine);
		}

		// ── registration ────────────────────────────────────────────────────────
		/** Strict codec stubs: the Host's `assertJsonValue` already guarantees JSON-safe output. */
		function makeCodec(kind) {
			return {
				mode: "strict",
				typeSymbol: `dsh-mode-gate/types#${kind}`,
				schema: { parse(value) { return value; } },
			};
		}
		/** Hand-written Typert Remote face for the Host `modeGate` service methods. */
		const TYPERT_REMOTE = {
			package: "dsh-mode-gate",
			descriptors: [{
				id: "dsh-mode-gate#modeGate/getState",
				service: "modeGate",
				namespace: "modeGate",
				method: "getState",
				invocation: { kind: "direct" },
				parameters: [{
					name: "args",
					wire: "args",
					source: "json",
					codec: makeCodec("GetStateArgs"),
				}],
				result: makeCodec("GetStateResult"),
			}, {
				id: "dsh-mode-gate#modeGate/getBashDenyList",
				service: "modeGate",
				namespace: "modeGate",
				method: "getBashDenyList",
				invocation: { kind: "direct" },
				parameters: [],
				result: makeCodec("GetBashDenyListResult"),
			}, {
				id: "dsh-mode-gate#modeGate/setBashDenyList",
				service: "modeGate",
				namespace: "modeGate",
				method: "setBashDenyList",
				invocation: { kind: "direct" },
				parameters: [{
					name: "args",
					wire: "args",
					source: "json",
					codec: makeCodec("SetBashDenyListArgs"),
				}],
				result: makeCodec("SetBashDenyListResult"),
			}],
		};

		const NS = "settings.modeGate";
		const inject = ["slots", "locale", "sessions", "remote"];

		async function apply(ctx) {
			console.log("[dsh-mode-gate] client apply start");
			const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
			ctx.effect(() => () => disposeRemote(), "dsh-mode-gate: remote face");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-mode-gate: dictionaries");
			const t = ctx.locale.bind(NS);
			const api = () => {
				const modeGate = ctx.get("remote.modeGate");
				if (modeGate === undefined) throw new Error("remote.modeGate service is not mounted");
				return modeGate;
			};

			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "mode-gate",
				order: 40,
				label: () => t("tab"),
				locale: NS,
				inject: () => ({ api })
			}, ModeGateSettingsTab));

			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "mode-gate",
				order: 50,
				locale: NS,
				inject: () => ({ sessions: ctx.get("sessions"), api })
			}, ModeGateFooterAction));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
