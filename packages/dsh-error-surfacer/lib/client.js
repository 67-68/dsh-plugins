window.__ModuleLoader__.load({
	id: "dsh-error-surfacer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ── inline styles (theme-token based, no global CSS) ────────────────
		const styles = {
			container: {
				position: "absolute",
				right: 16,
				bottom: 16,
				display: "flex",
				flexDirection: "column",
				alignItems: "flex-end",
				gap: 8,
				maxWidth: 420,
				pointerEvents: "auto"
			},
			badge: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				background: "var(--dsw-alias-bg-layer-3)",
				color: "var(--dsw-alias-label-primary)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 999,
				padding: "5px 12px",
				font: "inherit",
				fontSize: 12,
				lineHeight: "18px",
				cursor: "pointer",
				boxShadow: "0 2px 8px rgba(0, 0, 0, 0.12)"
			},
			badgeActive: {
				border: "1px solid var(--dsw-alias-state-error-primary)",
				color: "var(--dsw-alias-state-error-primary)"
			},
			badgeEmpty: {
				opacity: 0.45
			},
			list: {
				width: 400,
				maxHeight: 320,
				overflowY: "auto",
				background: "var(--dsw-alias-bg-layer-3)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 10,
				padding: "10px 12px",
				display: "flex",
				flexDirection: "column",
				gap: 8
			},
			item: {
				borderTop: "1px solid var(--dsw-alias-border-l2)",
				paddingTop: 8
			},
			itemMessage: {
				color: "var(--dsw-alias-label-primary)",
				fontSize: 12,
				lineHeight: "18px",
				wordBreak: "break-word"
			},
			itemStack: {
				margin: "4px 0 0",
				padding: "6px 8px",
				background: "var(--dsw-alias-bg-module-platform)",
				color: "var(--dsw-alias-state-error-primary)",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				fontSize: 11,
				lineHeight: "16px",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				borderRadius: 6,
				maxHeight: 120,
				overflowY: "auto"
			},
			itemMeta: {
				display: "flex",
				gap: 8,
				marginTop: 4
			},
			itemSource: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 11,
				lineHeight: "16px"
			},
			itemTime: {
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: 11,
				lineHeight: "16px",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
			},
			clear: {
				alignSelf: "flex-end",
				border: "1px solid var(--dsw-alias-border-l2)",
				color: "var(--dsw-alias-label-primary)",
				background: "none",
				font: "inherit",
				fontSize: 12,
				lineHeight: "18px",
				borderRadius: 6,
				padding: "3px 10px",
				cursor: "pointer"
			},
			empty: {
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: 12,
				margin: 0
			}
		};

		function formatTime(timestamp) {
			const date = new Date(timestamp);
			if (Number.isNaN(date.getTime())) return "";
			const pad = (n) => String(n).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}

		// ── component ────────────────────────────────────────────────────────
		function ErrorSurfacerPanel(props) {
			const { subscribe, snapshot, clear } = props;
			const [errors, setErrors] = react.useState(snapshot);
			const [expanded, setExpanded] = react.useState(false);
			react.useEffect(() => subscribe(setErrors), [subscribe]);

			const count = errors.length;

			const badge = react.createElement("button", {
				key: "badge",
				type: "button",
				onClick: () => setExpanded((value) => !value),
				"aria-expanded": expanded,
				title: "浏览器报错",
				style: {
					...styles.badge,
					...(count > 0 ? styles.badgeActive : styles.badgeEmpty)
				}
			}, `报错 ${count}`);

			const children = [badge];

			if (expanded) {
				const body = [];
				if (count === 0) {
					body.push(react.createElement("p", { key: "empty", style: styles.empty }, "暂无浏览器报错。"));
				} else {
					for (let i = 0; i < errors.length; i++) {
						const error = errors[i];
						const itemChildren = [
							react.createElement("div", { key: "message", style: styles.itemMessage }, error.message || "(无消息)"),
							react.createElement("div", { key: "meta", style: styles.itemMeta }, [
								react.createElement("span", { key: "source", style: styles.itemSource }, error.source),
								react.createElement("span", { key: "time", style: styles.itemTime }, formatTime(error.timestamp)),
							]),
						];
						if (error.stack) itemChildren.splice(1, 0, react.createElement("pre", { key: "stack", style: styles.itemStack }, error.stack));
						body.push(react.createElement("div", { key: `${error.timestamp}:${i}`, style: styles.item }, itemChildren));
					}
				}
				body.push(react.createElement("button", {
					key: "clear",
					type: "button",
					onClick: clear,
					style: styles.clear
				}, "清空"));
				children.push(react.createElement("div", { key: "list", style: styles.list }, body));
			}

			return react.createElement("div", { style: styles.container }, children);
		}

		// ── hand-written Typert Remote face ──────────────────────────────────
		// The Host dispatches these endpoints through the SRC fallback in
		// `dsh-api-gateway` (no generated `./typert` artifact needed). The Client
		// only needs a strict codec with a `parse()` method; field-level
		// validation is intentionally omitted — the Host's `assertJsonValue`
		// already guarantees JSON-safe output.
		const passthroughSchema = {
			parse(value) {
				return value;
			}
		};
		const errorReportCodec = {
			mode: "strict",
			typeSymbol: "dsh-error-surfacer/types#ErrorReport",
			schema: passthroughSchema
		};
		const TYPERT_REMOTE = {
			package: "dsh-error-surfacer",
			descriptors: [{
				id: "dsh-error-surfacer#errorSurfacer/report",
				service: "errorSurfacer",
				namespace: "errorSurfacer",
				method: "report",
				invocation: { kind: "direct" },
				parameters: [{
					name: "error",
					wire: "error",
					source: "json",
					codec: errorReportCodec
				}],
				result: {
					mode: "strict",
					typeSymbol: "dsh-error-surfacer/types#ReportResult",
					schema: passthroughSchema
				}
			}, {
				id: "dsh-error-surfacer#errorSurfacer/clear",
				service: "errorSurfacer",
				namespace: "errorSurfacer",
				method: "clear",
				invocation: { kind: "direct" },
				parameters: [],
				result: {
					mode: "strict",
					typeSymbol: "dsh-error-surfacer/types#ClearResult",
					schema: passthroughSchema
				}
			}]
		};

		/** Namespace identifier owned by this plugin (no locale dependency). */
		const NS = "shell.errorSurfacer";
		/** Services required by the overlay registration and the generated Remote face. */
		const inject = [
			"slots",
			"remote"
		];

		async function apply(ctx) {
			console.log("[dsh-error-surfacer] apply start, mounting remote face");
			const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
			console.log("[dsh-error-surfacer] remote face mounted, namespace=errorSurfacer");
			ctx.effect(() => () => disposeRemote(), "dsh-error-surfacer: remote face");

			// Local error store shared between window listeners and the panel.
			let errors = [];
			const listeners = new Set();
			const emit = () => {
				const snapshot = errors.slice();
				for (const listener of listeners) listener(snapshot);
			};

			const remoteService = () => ctx.get("remote.errorSurfacer");

			const reportToHost = (entry) => {
				const service = remoteService();
				if (service === undefined) return;
				Promise.resolve()
					.then(() => service.report(entry))
					.then((result) => {
						if (!result.ok) console.error("[dsh-error-surfacer] report failed:", result.error);
					})
					.catch((error) => console.error("[dsh-error-surfacer] report threw:", error));
			};

			const clearAll = () => {
				errors = [];
				emit();
				const service = remoteService();
				if (service === undefined) return;
				Promise.resolve()
					.then(() => service.clear())
					.then((result) => {
						if (!result.ok) console.error("[dsh-error-surfacer] clear failed:", result.error);
					})
					.catch((error) => console.error("[dsh-error-surfacer] clear threw:", error));
			};

			const toEntry = (source, message, stack) => ({
				source,
				message: message || "",
				stack: stack || "",
				timestamp: Date.now()
			});

			ctx.effect(() => {
				const onError = (event) => {
					const error = event.error;
					const message = error && error.message ? error.message : String(event.message || "");
					const stack = error && error.stack ? error.stack : "";
					const entry = toEntry("error", message, stack);
					errors.push(entry);
					emit();
					reportToHost(entry);
				};
				const onRejection = (event) => {
					const reason = event.reason;
					const message = reason && reason.message ? reason.message : (reason === undefined ? "unhandledrejection" : String(reason));
					const stack = reason && reason.stack ? reason.stack : "";
					const entry = toEntry("unhandledrejection", message, stack);
					errors.push(entry);
					emit();
					reportToHost(entry);
				};
				window.addEventListener("error", onError);
				window.addEventListener("unhandledrejection", onRejection);
				return () => {
					window.removeEventListener("error", onError);
					window.removeEventListener("unhandledrejection", onRejection);
				};
			}, "dsh-error-surfacer: window error capture");

			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "error-surfacer",
				order: 9000,
				inject: () => ({
					subscribe: (listener) => {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					snapshot: () => errors.slice(),
					clear: clearAll
				})
			}, ErrorSurfacerPanel));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
