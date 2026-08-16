window.__ModuleLoader__.load({
	id: "dsh-music-alert",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ── locales ─────────────────────────────────────────────────────────────
		const zh = {
			tab: "音乐提醒",
			loading: "正在读取音乐…",
			error: "暂时无法读取。",
			retry: "重试",
			empty: "暂无音乐，请上传",
			enableLabel: "启用完成播报",
			upload: "上传",
			chooseFile: "选择音频文件",
			play: "播放",
			setDefault: "设为完成音",
			delete: "删除",
			defaultBadge: "完成音",
			confirmDelete: "确定删除该音乐文件吗？",
		};
		const en = {
			tab: "Music Alert",
			loading: "Reading music…",
			error: "Unavailable right now.",
			retry: "Retry",
			empty: "No music yet, upload one",
			enableLabel: "Enable completion sound",
			upload: "Upload",
			chooseFile: "Choose an audio file",
			play: "Play",
			setDefault: "Set as completion",
			delete: "Delete",
			defaultBadge: "Completion",
			confirmDelete: "Delete this audio file?",
		};

		// ── styles (inline, theme-token based) ─────────────────────────────────
		const styles = {
			section: { width: "100%", maxWidth: 760, color: "var(--dsw-alias-label-primary)", display: "flex", flexDirection: "column", gap: 14 },
			status: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: "20px", margin: 0 },
			failure: { color: "var(--dsw-alias-state-error-primary)", display: "flex", alignItems: "center", gap: 10 },
			card: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: 10, padding: "12px 14px", minWidth: 0 },
			row: { display: "flex", alignItems: "center", gap: 8, padding: "7px 0", fontSize: 12, lineHeight: "18px" },
			rowId: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "var(--dsw-alias-label-primary)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			rowSize: { color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap" },
			rows: { listStyle: "none", margin: "10px 0 0", padding: 0, borderTop: "1px solid var(--dsw-alias-border-l2)" },
			rowItem: { display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--dsw-alias-border-l2)", fontSize: 12, lineHeight: "18px" },
			badge: { whiteSpace: "nowrap", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", borderRadius: 999, padding: "1px 8px", fontSize: 11, lineHeight: "17px" },
			button: { border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", background: "none", borderRadius: 6, padding: "3px 10px", fontSize: 12 },
			buttonDanger: { border: "1px solid var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)", font: "inherit", cursor: "pointer", background: "none", borderRadius: 6, padding: "3px 10px", fontSize: 12 },
			retry: { border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", background: "none", borderRadius: 6, padding: "4px 10px" },
		};

		// ── Remote face (hand-written Typert Remote descriptors) ────────────────
		function strictCodec(typeSymbol) {
			return {
				mode: "strict",
				typeSymbol,
				schema: { parse(value) { return value; } }
			};
		}
		function directDescriptor(method, paramTypeSymbol) {
			return {
				id: `dsh-music-alert#musicAlert/${method}`,
				service: "musicAlert",
				namespace: "musicAlert",
				method,
				invocation: { kind: "direct" },
				parameters: paramTypeSymbol ? [{
					name: "args",
					wire: "args",
					source: "json",
					codec: strictCodec(paramTypeSymbol)
				}] : [],
				result: strictCodec(`dsh-music-alert/types#${method}Result`)
			};
		}
		const TYPERT_REMOTE = {
			package: "dsh-music-alert",
			descriptors: [
				directDescriptor("list"),
				directDescriptor("save", "dsh-music-alert/types#saveArgs"),
				directDescriptor("remove", "dsh-music-alert/types#removeArgs"),
				directDescriptor("play", "dsh-music-alert/types#playArgs"),
				directDescriptor("setDefault", "dsh-music-alert/types#setDefaultArgs"),
				directDescriptor("setEnabled", "dsh-music-alert/types#setEnabledArgs")
			]
		};

		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.musicAlert";
		/** Services required by the Settings registration and generated Remote face. */
		const inject = [
			"slots",
			"locale",
			"remote",
		];

		function formatSize(bytes) {
			const n = Number(bytes);
			if (!Number.isFinite(n) || n <= 0) return "0 B";
			const units = ["B", "KB", "MB", "GB"];
			let value = n;
			let index = 0;
			while (value >= 1024 && index < units.length - 1) {
				value /= 1024;
				index += 1;
			}
			return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
		}

		function remoteError(err) {
			if (err && typeof err === "object" && typeof err.message === "string") return err.message;
			return String(err || "remote failure");
		}

		/** Contribute the lazy music-alert tab to the Plugins settings section. */
		async function apply(ctx) {
			console.log("[music-alert] apply start, mounting remote face");
			const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
			console.log("[music-alert] remote face mounted, namespace=musicAlert");
			ctx.effect(() => () => disposeRemote(), "music-alert: remote face");
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "music-alert: dictionaries");
			const t = ctx.locale.bind(NS);

			// Dot access `ctx.remote.musicAlert` is blocked by the Cordis guard;
			// use ctx.get() to resolve the mounted namespace service instead.
			const api = () => {
				const service = ctx.get("remote.musicAlert");
				if (service === undefined) {
					console.error("[music-alert] remote.musicAlert service NOT found via ctx.get");
					throw new Error("remote.musicAlert service is not mounted");
				}
				return service;
			};

			const MusicSettingsComponent = (props) => {
				const [request, setRequest] = react.useState(0);
				const [state, setState] = react.useState({ status: "loading" });
				const [selectedFile, setSelectedFile] = react.useState(null);

				react.useEffect(() => {
					let current = true;
					Promise.resolve().then(() => api().list()).then(
						(result) => {
							if (!result.ok) throw new Error(remoteError(result.error));
							if (current) setState({ status: "ready", data: result.value });
						},
						(err) => {
							console.error("[music-alert] load FAILED:", err);
							if (current) setState({ status: "error" });
						}
					);
					return () => { current = false; };
				}, [request]);

				const reload = () => setRequest((value) => value + 1);

				const act = (promise) => {
					Promise.resolve().then(() => promise).then(
						(result) => {
							if (result && result.ok === false) {
								console.error("[music-alert] remote action failed:", remoteError(result.error));
							} else if (result && result.value && result.value.ok === false) {
								console.error("[music-alert] action rejected:", result.value.error);
							}
							reload();
						},
						(err) => {
							console.error("[music-alert] action failed:", err);
							reload();
						}
					);
				};

				const onPickFile = (event) => {
					const file = event.target.files && event.target.files[0];
					setSelectedFile(file || null);
				};

				const onUpload = () => {
					if (!selectedFile) return;
					const reader = new FileReader();
					reader.onload = () => {
						const dataUrl = String(reader.result || "");
						const comma = dataUrl.indexOf(",");
						const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
						act(api().save({ name: selectedFile.name, base64 }));
					};
					reader.onerror = () => console.error("[music-alert] failed to read selected file");
					reader.readAsDataURL(selectedFile);
				};

				const onRemove = (name) => {
					if (!window.confirm(t("confirmDelete"))) return;
					act(api().remove({ name }));
				};

				const retry = () => {
					setState({ status: "loading" });
					setRequest((value) => value + 1);
				};

				if (state.status === "loading") return react.createElement("p", { style: styles.status, "aria-busy": true }, t("loading"));
				if (state.status === "error") return react.createElement("div", { style: styles.failure }, [
					react.createElement("p", { key: "error", role: "alert", style: { margin: 0 } }, t("error")),
					react.createElement("button", { key: "retry", type: "button", onClick: retry, style: styles.retry }, t("retry")),
				]);

				const data = state.data || { files: [], defaultFile: "", enabled: false, player: "" };

				const toggle = react.createElement("label", { key: "toggle", style: styles.row }, [
					react.createElement("input", {
						key: "check",
						type: "checkbox",
						checked: !!data.enabled,
						onChange: (event) => act(api().setEnabled({ enabled: event.target.checked })),
					}),
					react.createElement("span", { key: "label", style: styles.rowSize }, t("enableLabel")),
				]);

				const uploader = react.createElement("div", { key: "upload", style: styles.row }, [
					react.createElement("input", {
						key: "file",
						type: "file",
						accept: "audio/*",
						onChange: onPickFile,
					}),
					react.createElement("button", {
						key: "upload",
						type: "button",
						disabled: !selectedFile,
						onClick: onUpload,
						style: styles.button,
					}, t("upload")),
				]);

				const listNode = data.files && data.files.length > 0
					? react.createElement("ul", { key: "files", style: styles.rows }, data.files.map((item) => react.createElement("li", { key: item.name, style: styles.rowItem }, [
						react.createElement("code", { key: "name", style: styles.rowId }, item.name),
						react.createElement("span", { key: "size", style: styles.rowSize }, formatSize(item.size)),
						item.isDefault ? react.createElement("span", { key: "default", style: styles.badge }, t("defaultBadge")) : null,
						react.createElement("button", { key: "play", type: "button", onClick: () => act(api().play({ name: item.name })), style: styles.button }, t("play")),
						react.createElement("button", { key: "setDefault", type: "button", onClick: () => act(api().setDefault({ name: item.name })), style: styles.button }, t("setDefault")),
						react.createElement("button", { key: "delete", type: "button", onClick: () => onRemove(item.name), style: styles.buttonDanger }, t("delete")),
					])))
					: react.createElement("p", { key: "empty", style: styles.status }, t("empty"));

				return react.createElement("div", { style: styles.section }, [
					react.createElement("div", { key: "card", style: styles.card }, [toggle, uploader]),
					listNode,
				]);
			};

			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "music",
				order: 30,
				label: () => t("tab"),
				locale: NS
			}, MusicSettingsComponent));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
