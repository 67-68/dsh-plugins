window.__ModuleLoader__.load({
	id: "dsh-permode-inventory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ── locales ─────────────────────────────────────────────────────────────
		const zh = {
			tab: "按模式插件清单",
			loading: "正在读取各模式的插件…",
			error: "暂时无法读取。",
			retry: "重试",
			empty: "没有匹配白名单的 preset。",
			trustSystem: "系统",
			trustUser: "用户",
			broken: "损坏",
			disabled: "已停用",
			noPlugins: "无插件行",
		};
		const en = {
			tab: "Plugins by mode",
			loading: "Reading per-mode plugins…",
			error: "Unavailable right now.",
			retry: "Retry",
			empty: "No presets match the whitelist.",
			trustSystem: "System",
			trustUser: "User",
			broken: "Broken",
			disabled: "Disabled",
			noPlugins: "No plugin rows",
		};

		// ── styles (inline, theme-token based) ─────────────────────────────────
		const styles = {
			section: { width: "100%", maxWidth: 760, color: "var(--dsw-alias-label-primary)", display: "flex", flexDirection: "column", gap: 14 },
			status: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: "20px", margin: 0 },
			failure: { color: "var(--dsw-alias-state-error-primary)", display: "flex", alignItems: "center", gap: 10 },
			retry: { border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", background: "none", borderRadius: 6, padding: "4px 10px" },
			card: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: 10, padding: "12px 14px", minWidth: 0 },
			cardHead: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			cardTitle: { fontSize: 14, fontWeight: 600, lineHeight: "20px", color: "var(--dsw-alias-label-primary)" },
			presetId: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
			badge: { whiteSpace: "nowrap", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", borderRadius: 999, padding: "1px 8px", fontSize: 11, lineHeight: "17px" },
			brokenBadge: { whiteSpace: "nowrap", color: "var(--dsw-alias-state-error-primary)", border: "1px solid var(--dsw-alias-state-error-primary)", borderRadius: 999, padding: "1px 8px", fontSize: 11, lineHeight: "17px" },
			brokenDetail: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, margin: "6px 0 0" },
			rows: { listStyle: "none", margin: "10px 0 0", padding: 0, borderTop: "1px solid var(--dsw-alias-border-l2)" },
			row: { display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--dsw-alias-border-l2)", fontSize: 12, lineHeight: "18px" },
			rowId: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "var(--dsw-alias-label-primary)" },
			rowName: { color: "var(--dsw-alias-label-secondary)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			rowDisabled: { whiteSpace: "nowrap", color: "var(--dsw-alias-label-tertiary)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 999, padding: "0 8px", fontSize: 11, lineHeight: "17px", marginLeft: "auto" },
			noPlugins: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, margin: "10px 0 0" },
		};

		// ── component ───────────────────────────────────────────────────────────
		function renderCard(preset, t) {
			const trustLabel = preset.trust === "system" ? t("trustSystem") : t("trustUser");
			const head = [
				react.createElement("span", { key: "title", style: styles.cardTitle }, preset.name),
				react.createElement("code", { key: "id", style: styles.presetId }, preset.presetId),
				react.createElement("span", { key: "trust", style: styles.badge }, trustLabel),
			];
			if (preset.broken) head.push(react.createElement("span", { key: "broken", style: styles.brokenBadge }, t("broken")));

			const body = [];
			if (preset.broken) body.push(react.createElement("p", { key: "brokenDetail", style: styles.brokenDetail }, preset.broken));
			if (preset.rows && preset.rows.length > 0) {
				body.push(react.createElement("ul", { key: "rows", style: styles.rows }, preset.rows.map((row, index) => {
					const cells = [
						react.createElement("code", { key: "id", style: styles.rowId }, row.id),
						react.createElement("span", { key: "name", style: styles.rowName }, row.name || "—"),
					];
					if (row.disabled) cells.push(react.createElement("span", { key: "disabled", style: styles.rowDisabled }, t("disabled")));
					return react.createElement("li", { key: `${row.id}:${index}`, style: styles.row, "data-plugin-row": row.id }, cells);
				})));
			} else {
				body.push(react.createElement("p", { key: "noPlugins", style: styles.noPlugins }, t("noPlugins")));
			}

			return react.createElement("div", { key: preset.presetId, style: styles.card, "data-preset-id": preset.presetId }, [
				react.createElement("div", { key: "head", style: styles.cardHead }, head),
				...body,
			]);
		}

		/** Render the read-only per-mode plugin inventory. */
		function PermodeInventorySettingsTab(props) {
			const { list, t } = props;
			const [request, setRequest] = react.useState(0);
			const [state, setState] = react.useState({ status: "loading" });
			react.useEffect(() => {
				let current = true;
				Promise.resolve().then(() => list()).then(
					(snapshot) => { if (current) setState({ status: "ready", snapshot }); },
					() => { if (current) setState({ status: "error" }); }
				);
				return () => { current = false; };
			}, [list, request]);

			const retry = () => {
				setState({ status: "loading" });
				setRequest((value) => value + 1);
			};

			if (state.status === "loading") return react.createElement("p", { style: styles.status, "aria-busy": true }, t("loading"));
			if (state.status === "error") return react.createElement("div", { style: styles.failure }, [
				react.createElement("p", { key: "error", role: "alert", style: { margin: 0 } }, t("error")),
				react.createElement("button", { key: "retry", type: "button", onClick: retry, style: styles.retry }, t("retry")),
			]);

			const snapshot = state.snapshot || [];
			if (snapshot.length === 0) return react.createElement("p", { style: styles.status }, t("empty"));

			return react.createElement("div", { style: styles.section }, snapshot.map((preset) => renderCard(preset, t)));
		}

		// ── registration ────────────────────────────────────────────────────────
		/**
		 * Hand-written Typert Remote face for the Host `permodeInventory/list`
		 * service. The Host dispatches this endpoint through the SRC fallback in
		 * `dsh-api-gateway` (no generated `./typert` artifact is needed on the
		 * Host side); the Client only needs a strict codec with a `parse()`
		 * method. No field-level validation is performed here — the Host's own
		 * `assertJsonValue` already guarantees JSON-safe output.
		 */
		const listResultSchema = {
			parse(value) {
				return value;
			}
		};
		const TYPERT_REMOTE = {
			package: "dsh-permode-inventory",
			descriptors: [{
				id: "dsh-permode-inventory#permodeInventory/list",
				service: "permodeInventory",
				namespace: "permodeInventory",
				method: "list",
				invocation: { kind: "direct" },
				parameters: [],
				result: {
					mode: "strict",
					typeSymbol: "dsh-permode-inventory/types#PermodeInventorySnapshot",
					schema: listResultSchema
				}
			}]
		};
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.permodeInventory";
		/** Services required by the Settings registration and generated Remote face. */
		const inject = [
			"slots",
			"locale",
			"remote",
		];
		/** Contribute the lazy per-mode inventory tab to the Plugins settings section. */
		async function apply(ctx) {
			const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
			ctx.effect(() => () => disposeRemote(), "permode-inventory: remote face");
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "permode-inventory: dictionaries");
			const t = ctx.locale.bind(NS);
			const list = async () => {
				const result = await ctx.remote.permodeInventory.list();
				if (!result.ok) throw new Error(`permodeInventory.list failed: ${result.error.code}: ${result.error.message}`);
				return result.value;
			};
			const injected = () => ({ list });
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "modes",
				order: 20,
				label: () => t("tab"),
				locale: NS,
				inject: injected
			}, PermodeInventorySettingsTab));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
