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
			loading: "正在读取音乐库…",
			error: "暂时无法读取。",
			retry: "重试",
			enabled: "启用完成播报",
			uploadLabel: "上传音乐",
			uploadButton: "上传",
			noFiles: "暂无音乐，请上传。",
			play: "播放",
			setDefault: "设为完成音",
			isDefault: "完成音",
			remove: "删除",
			player: "播放器",
			bytes: "字节",
		};
		const en = {
			tab: "Music alert",
			loading: "Reading music library…",
			error: "Unavailable right now.",
			retry: "Retry",
			enabled: "Enable completion sound",
			uploadLabel: "Upload music",
			uploadButton: "Upload",
			noFiles: "No music yet. Upload one above.",
			play: "Play",
			setDefault: "Set as completion sound",
			isDefault: "Completion sound",
			remove: "Delete",
			player: "Player",
			bytes: "bytes",
		};

		// ── styles (inline, theme-token based) ─────────────────────────────────
		const styles = {
			section: { width: "100%", maxWidth: 760, color: "var(--dsw-alias-label-primary)", display: "flex", flexDirection: "column", gap: 14 },
			status: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: "20px", margin: 0 },
			failure: { color: "var(--dsw-alias-state-error-primary)", display: "flex", alignItems: "center", gap: 10 },
			retry: { border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", background: "none", borderRadius: 6, padding: "4px 10px" },
			row: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13, lineHeight: "20px" },
			toggleLabel: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
			meta: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 },
			upload: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
			uploadName: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280 },
			button: { border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", background: "none", borderRadius: 6, padding: "4px 10px" },
			buttonPrimary: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", borderRadius: 6, padding: "4px 10px" },
			list: { listStyle: "none", margin: "0", padding: 0, borderTop: "1px solid var(--dsw-alias-border-l2)" },
			item: { display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--dsw-alias-border-l2)", flexWrap: "wrap" },
			itemName: { color: "var(--dsw-alias-label-primary)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			badge: { whiteSpace: "nowrap", background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-secondary)", borderRadius: 999, padding: "1px 8px", fontSize: 11, lineHeight: "17px" },
			spacer: { marginLeft: "auto" },
		};

		/** Human-readable byte size. */
		function formatSize(bytes) {
			if (typeof bytes !== "number" || bytes <= 0) return "0 B";
			const units = ["B", "KB", "MB", "GB"];
			let value = bytes;
			let index = 0;
			while (value >= 1024 && index < units.length - 1) {
				value /= 1024;
				index += 1;
			}
			return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
		}

		// ── component ───────────────────────────────────────────────────────────
		/** Upload + list + playback settings panel for the music library. */
		function MusicSettingsComponent(props) {
			const { api, t } = props;
			const [request, setRequest] = react.useState(0);
			const [state, setState] = react.useState({ status: "loading" });
			const [busy, setBusy] = react.useState(false);
			const [pendingFile, setPendingFile] = react.useState(null);
			const fileInputRef = react.useRef(null);

			const refresh = react.useCallback(() => {
				setRequest((value) => value + 1);
			}, []);

			react.useEffect(() => {
				let current = true;
				setState((prev) => ({ ...prev, status: "loading" }));
				Promise.resolve().then(() => api().list()).then(
					(result) => {
						if (!result.ok) throw new Error(result.error && result.error.message ? result.error.message : String(result.error));
						if (current) setState({ status: "ready", data: result.value });
					},
					(err) => {
						console.error("[dsh-music-alert] list FAILED:", err);
						if (current) setState({ status: "error" });
					}
				);
				return () => { current = false; };
			}, [api, request]);

			const retry = () => {
				setState({ status: "loading" });
				refresh();
			};

			const run = async (fn) => {
				setBusy(true);
				try {
					const result = await fn();
					console.log("[dsh-music-alert] run result: ok=", result && result.ok, result && result.error ? "err=" + String(result.error) : "");
					if (!result.ok) console.error("[dsh-music-alert] operation failed:", result.error);
				} catch (err) {
					console.error("[dsh-music-alert] operation error:", err);
				} finally {
					setBusy(false);
					refresh();
				}
			};

			const toggleEnabled = (enabled) => run(() => api().setEnabled({ enabled }));

			const onPick = (event) => {
				const file = event.target.files && event.target.files[0];
				setPendingFile(file || null);
			};

			const onUpload = () => {
				const file = pendingFile;
				if (!file) return;
				console.log("[dsh-music-alert] onUpload: name=", file.name, "size=", file.size, "type=", file.type);
				const reader = new FileReader();
				reader.onload = () => {
					const dataUrl = String(reader.result || "");
					const comma = dataUrl.indexOf(",");
					const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
					console.log("[dsh-music-alert] onUpload: read done, base64Len=", base64.length);
					setPendingFile(null);
					if (fileInputRef.current) fileInputRef.current.value = "";
					run(() => api().save({ name: file.name, base64 }));
				};
				reader.onerror = () => console.error("[dsh-music-alert] file read failed");
				reader.readAsDataURL(file);
			};

			const doPlay = (name) => run(() => api().play({ name }));
			const doSetDefault = (name) => run(() => api().setDefault({ name }));
			const doRemove = (name) => {
				if (!window.confirm(`${t("remove")}: ${name}?`)) return;
				run(() => api().deleteFile({ name }));
			};

			if (state.status === "loading") return react.createElement("p", { style: styles.status, "aria-busy": true }, t("loading"));
			if (state.status === "error") return react.createElement("div", { style: styles.failure }, [
				react.createElement("p", { key: "error", role: "alert", style: { margin: 0 } }, t("error")),
				react.createElement("button", { key: "retry", type: "button", onClick: retry, style: styles.retry }, t("retry")),
			]);

			const data = state.data || { files: [], defaultFile: "", enabled: false, player: "" };
			const files = data.files || [];
			const enabled = !!data.enabled;

			const head = [
				react.createElement("label", { key: "toggle", style: styles.toggleLabel },
					react.createElement("input", {
						type: "checkbox",
						checked: enabled,
						disabled: busy,
						onChange: (event) => toggleEnabled(event.target.checked),
					}),
					react.createElement("span", null, t("enabled"))
				),
				react.createElement("div", { key: "upload", style: styles.upload }, [
					react.createElement("input", {
						ref: fileInputRef,
						type: "file",
						accept: "audio/*",
						onChange: onPick,
					}),
					react.createElement("button", {
						type: "button",
						onClick: onUpload,
						disabled: busy || !pendingFile,
						style: styles.buttonPrimary,
					}, t("uploadButton")),
					pendingFile ? react.createElement("span", { key: "pendingName", style: styles.uploadName }, pendingFile.name) : null,
				]),
			];

			if (data.player) {
				head.push(react.createElement("span", { key: "player", style: styles.meta }, `${t("player")}: ${data.player}`));
			}

			let body;
			if (files.length === 0) {
				body = react.createElement("p", { key: "empty", style: styles.status }, t("noFiles"));
			} else {
				body = react.createElement("ul", { key: "list", style: styles.list }, files.map((file, index) => {
					const cells = [
						react.createElement("span", { key: "name", style: styles.itemName }, file.name),
						react.createElement("span", { key: "size", style: styles.meta }, formatSize(file.size)),
					];
					if (file.isDefault) cells.push(react.createElement("span", { key: "badge", style: styles.badge }, t("isDefault")));
					cells.push(react.createElement("span", { key: "spacer", style: styles.spacer }));
					cells.push(react.createElement("button", {
						key: "play",
						type: "button",
						onClick: () => doPlay(file.name),
						disabled: busy,
						style: styles.button,
					}, t("play")));
					if (!file.isDefault) cells.push(react.createElement("button", {
						key: "setDefault",
						type: "button",
						onClick: () => doSetDefault(file.name),
						disabled: busy,
						style: styles.button,
					}, t("setDefault")));
					cells.push(react.createElement("button", {
						key: "remove",
						type: "button",
						onClick: () => doRemove(file.name),
						disabled: busy,
						style: styles.button,
					}, t("remove")));
					return react.createElement("li", { key: `${file.name}:${index}`, style: styles.item }, cells);
				}));
			}

			return react.createElement("div", { style: styles.section }, [head, body]);
		}

		// ── registration ────────────────────────────────────────────────────────
		/** A strict codec stub: the Host's `assertJsonValue` already guarantees JSON-safe output. */
		function makeCodec(method, kind) {
			return {
				mode: "strict",
				typeSymbol: `dsh-music-alert/types#${kind === "args" ? method + "Args" : method + "Result"}`,
				schema: { parse(value) { return value; } },
			};
		}
		/** Single-object-parameter wire shape for every Remote method that takes arguments. */
		function argsParameter(method) {
			return [{
				name: "args",
				wire: "args",
				source: "json",
				codec: makeCodec(method, "args"),
			}];
		}
		function makeDescriptor(method, hasArgs) {
			return {
				id: `dsh-music-alert#musicAlert/${method}`,
				service: "musicAlert",
				namespace: "musicAlert",
				method,
				invocation: { kind: "direct" },
				parameters: hasArgs ? argsParameter(method) : [],
				result: makeCodec(method, "result"),
			};
		}

		/**
		 * Hand-written Typert Remote face for the Host `musicAlert/*` service.
		 * The Host dispatches through the SRC fallback in `dsh-api-gateway` (no
		 * generated `./typert` artifact needed); the Client only needs strict
		 * codecs exposing a `parse()` method.
		 */
		const TYPERT_REMOTE = {
			package: "dsh-music-alert",
			descriptors: [
				makeDescriptor("list", false),
				makeDescriptor("save", true),
				makeDescriptor("deleteFile", true),
				makeDescriptor("play", true),
				makeDescriptor("setDefault", true),
				makeDescriptor("setEnabled", true),
			],
		};
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.musicAlert";
		/** Services required by the Settings registration and generated Remote face. */
		const inject = [
			"slots",
			"locale",
			"remote",
		];
		/** Contribute the music alert tab to the Plugins settings section. */
		async function apply(ctx) {
			console.log("[dsh-music-alert] apply start, mounting remote face");
			const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
			console.log("[dsh-music-alert] remote face mounted, namespace=musicAlert");
			ctx.effect(() => () => disposeRemote(), "dsh-music-alert: remote face");
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-music-alert: dictionaries");
			const t = ctx.locale.bind(NS);
			const api = () => {
				// Dot access `ctx.remote.musicAlert` is blocked by the Cordis guard;
				// use ctx.get() to resolve the mounted namespace service.
				const musicAlert = ctx.get("remote.musicAlert");
				if (musicAlert === undefined) {
					console.error("[dsh-music-alert] remote.musicAlert service NOT found via ctx.get");
					throw new Error("remote.musicAlert service is not mounted");
				}
				return musicAlert;
			};
			const injected = () => ({ api });
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "music",
				order: 30,
				label: () => t("tab"),
				locale: NS,
				inject: injected
			}, MusicSettingsComponent));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
