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
			desc: "当前版本的设置页只展示各模式的权限定义；编辑能力会在后续版本加入。",
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
		};
		const en = {
			tab: "Mode Gate",
			title: "dsh-mode-gate permissions",
			desc: "This settings tab currently shows the permission definition of each mode. Editing is coming in a later version.",
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
			const { t } = props;
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
			return react.createElement("div", { style: styles.section }, head, table);
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
		/** Hand-written Typert Remote face for the Host `modeGate/getState` service. */
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
				inject: () => ({})
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
