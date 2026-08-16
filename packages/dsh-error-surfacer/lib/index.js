import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// Compiled decorator helpers (verbatim from @deepseek-ai/dsh-permode-inventory):
// the `@Remote("...")` decorator is applied through these at class definition time.
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};

// ── module-level ring buffer ───────────────────────────────────────────────
// Only minimal JSON scalars are stored here — never any DSH/Cordis live object.
const MAX_ENTRIES = 200;
const errorBuffer = [];
let nextId = 1;

function normalizeError(error) {
	const value = error && typeof error === "object" ? error : {};
	return {
		id: nextId++,
		source: typeof value.source === "string" ? value.source : "unknown",
		message: typeof value.message === "string" ? value.message : (value.message == null ? "" : String(value.message)),
		stack: typeof value.stack === "string" ? value.stack : "",
		timestamp: typeof value.timestamp === "number" && Number.isFinite(value.timestamp) ? value.timestamp : Date.now(),
	};
}

function appendError(error) {
	const entry = normalizeError(error);
	errorBuffer.push(entry);
	if (errorBuffer.length > MAX_ENTRIES) errorBuffer.shift();
	return entry;
}

/** Pure-JSON snapshot: detached copies, no live references. */
function snapshot() {
	return errorBuffer.map((entry) => ({ ...entry }));
}

function clearBuffer() {
	errorBuffer.length = 0;
}

// ── tool definition (raw ToolDefinition, registered via ctx.tools.register) ─
const BROWSER_ERRORS_TOOL = {
	name: "browser_errors",
	description: "读取或清空浏览器页面的报错缓冲。list 返回当前累积的浏览器报错快照（数组，每项含 id/source/message/stack/timestamp），clear 清空缓冲。用于 agent 自查浏览器页面异常。",
	parameters: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: ["list", "clear"],
				description: "要执行的操作：list 返回错误缓冲快照；clear 清空缓冲。缺省为 list。"
			}
		}
	},
	output: {
		schema: {
			oneOf: [
				{ type: "array", items: { type: "object" } },
				{ type: "object", properties: { cleared: { type: "boolean" } } }
			]
		},
		render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
	},
	async execute(args) {
		const action = args && args.action ? args.action : "list";
		if (action === "clear") {
			clearBuffer();
			return { cleared: true };
		}
		return snapshot();
	},
};

// ── skill definition ───────────────────────────────────────────────────────
const SKILL_CONTENT = [
	"# browser-error-diagnostics 技能",
	"",
	"定位「浏览器页面报错」和「启动期插件报错」的排查手册。本技能只负责让报错「可见 + 可定位 + 可隔离」，不吞报错。",
	"",
	"## 1. 何时该查浏览器报错",
	"",
	"出现以下任一情况时，先查浏览器报错，而不是盲猜：",
	"- 页面行为异常（点了没反应、面板不出现、数据不刷新）。",
	"- 某个插件/功能应该在 UI 里出现但没出现（tab、悬浮面板、工具栏按钮等）。",
	"- 动态插件 `cordis_run` 卡片报 client-render / client 激活错误。",
	"- 控制台或界面出现红色错误提示、功能半残。",
	"",
	"## 2. 怎么查",
	"",
	"优先级从高到低：",
	"1. **调 `browser_errors` 工具**（首选）。`action: \"list\"` 读缓冲快照（返回 `{id, source, message, stack, timestamp}` 数组）；`action: \"clear\"` 清空缓冲（返回 `{cleared: true}`）。这是 host 侧工具，agent 无需开浏览器即可读。",
	"2. **浏览器 F12 Console** 兜底；页面右下角「报错 N」悬浮徽标也可直接点开看列表。",
	"3. **`cordis_inspect_self(pluginId, packageId)`** 读动态插件的 client-render 诊断与 stack（需同时给 pluginId 和 packageId 才返回源码与诊断）。",
	"",
	"## 3. 启动期插件报错定位",
	"",
	"`dsh web` 启动时，终端 stderr 里出现以下任一行，就是启动期插件报错：",
	"- `dsh: N entries did not activate` —— 有 N 个插件行没激活（通常是 pending 等某个 service）。",
	"- `fatal load failure` —— 某个包加载致命失败。",
	"- `failed to apply loader entry <id>` —— 某个 loader 行 apply 抛错。",
	"",
	"这些行会直接点名：",
	"- **是哪个插件**：`<id>` / name。",
	"- **哪一步**：import（模块解析失败，多半是包名/路径/peer 依赖问题）还是 apply（运行时抛错）。",
	"- **原始 stack**：紧跟着的那段堆栈就是根因。",
	"",
	"## 4. 隔离手段",
	"",
	"host composition 层的插件报错会让整个 `dsh web` 起不来（bootstrap 的 fail-fast 语义，本模块不改变它）。隔离办法：",
	"1. 在对应插件行加 `disabled: true`（或用 `plugin_toggle` 工具按 entry id 停用）。",
	"2. 重启 `dsh web` 验证。",
	"3. 确认坏插件被隔离后，再修根因、重新启用。",
	"",
	"注意：本技能/插件**不吞启动报错**，只负责让报错可见、可定位、可用 disabled 隔离。真正修复还是要改那个坏插件本身。",
].join("\n");

// ── Remote service (namespace "errorSurfacer", methods report / clear) ──────
let ErrorSurfacerGateway = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _report_decorators;
	let _clear_decorators;
	return class ErrorSurfacerGateway extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_report_decorators = [Remote("report")];
			__esDecorate(this, null, _report_decorators, {
				kind: "method",
				name: "report",
				static: false,
				private: false,
				access: {
					has: (obj) => "report" in obj,
					get: (obj) => obj.report
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			_clear_decorators = [Remote("clear")];
			__esDecorate(this, null, _clear_decorators, {
				kind: "method",
				name: "clear",
				static: false,
				private: false,
				access: {
					has: (obj) => "clear" in obj,
					get: (obj) => obj.clear
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = ["tools", "skills"];
		constructor(ctx, config) {
			super(ctx, "errorSurfacer");
			__runInitializers(this, _instanceExtraInitializers);
			// Optional per-row config: maxEntries (default 200).
			if (config && Number.isInteger(config.maxEntries) && config.maxEntries > 0) {
				this.maxEntries = config.maxEntries;
			} else {
				this.maxEntries = MAX_ENTRIES;
			}
			// Tool and skill registrations return disposers; hand them to the fiber.
			this.ctx.effect(() => this.ctx.tools.register(BROWSER_ERRORS_TOOL), "error-surfacer: browser_errors tool");
			this.ctx.effect(() => this.ctx.skills.register({
				name: "browser-error-diagnostics",
				description: "定位浏览器页面报错与插件启动报错的排查手册：何时查、怎么查（browser_errors 工具 / F12 Console / cordis_inspect_self）、如何定位启动期是哪个插件挂了、如何用 disabled 隔离。",
				source: "runtime",
				content: SKILL_CONTENT,
			}), "error-surfacer: browser-error-diagnostics skill");
		}
		/**
		 * Append a client-reported browser error to the ring buffer.
		 * @returns { count } — pure JSON.
		 */
		async report(error) {
			appendError(error);
			return { count: errorBuffer.length };
		}
		/**
		 * Clear the ring buffer.
		 * @returns { count: 0 } — pure JSON.
		 */
		async clear() {
			clearBuffer();
			return { count: 0 };
		}
	};
})();

export { ErrorSurfacerGateway, ErrorSurfacerGateway as default };
