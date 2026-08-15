import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// Compiled decorator helpers (verbatim from @deepseek-ai/dsh-host-plugin-inventory):
// the `@Remote("list")` decorator is applied through these at class definition time.
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

/** Preset ids shown by default; overridable via the host row's config.presetIds. */
const DEFAULT_PRESET_IDS = ["architect", "g-chat", "cordis-architect", "code"];

/** Strip a matching pair of surrounding single/double quotes from a YAML scalar. */
function unquote(value) {
	const v = value.trim();
	if (v.length >= 2) {
		const first = v[0];
		const last = v[v.length - 1];
		if ((first === "'" && last === "'") || (first === '"' && last === '"')) return v.slice(1, -1);
	}
	return v;
}

/**
 * Whether a `disabled:` value reads as disabled. `false` (and empty/absent) is
 * the only enabled reading; `true` and `!!js <expr>` expressions count as
 * disabled (an expression is a conditional disable this inventory cannot
 * evaluate, so it is flagged rather than silently dropped).
 */
function parseDisabled(raw) {
	if (raw === void 0) return false;
	const value = raw.trim();
	return value !== "" && value !== "false";
}

/**
 * Extract every plugin row from an agent.cordis.yml top-level list.
 *
 * A row starts at a `- id:` line (top-level at column 0, or nested inside a
 * `group`/`isolate` block at deeper indentation). `name`/`disabled` are read
 * only from the row's own two-space field indent, so deeper `config:` content
 * (including `|-` text blocks) is ignored.
 *
 * @param text - the raw agent.cordis.yml composition text.
 * @returns rows as { id, name?, disabled }; `name` is omitted when absent.
 */
function parseRows(text) {
	const rows = [];
	if (typeof text !== "string") return rows;
	const lines = text.split(/\r?\n/);
	let current = null;
	const flush = () => {
		if (current === null) return;
		const row = { id: current.id, disabled: current.disabled };
		if (current.name !== void 0) row.name = current.name;
		rows.push(row);
	};
	for (const line of lines) {
		const rowMatch = /^(\s*)-\s+id:\s*(.+?)\s*$/.exec(line);
		if (rowMatch) {
			flush();
			current = {
				id: unquote(rowMatch[2]),
				name: void 0,
				disabled: false,
				fieldIndent: rowMatch[1].length + 2
			};
			continue;
		}
		if (current === null) continue;
		const fieldMatch = /^(\s*)(name|disabled):\s*(.*?)\s*$/.exec(line);
		if (!fieldMatch) continue;
		if (fieldMatch[1].length !== current.fieldIndent) continue;
		if (fieldMatch[2] === "name") current.name = unquote(fieldMatch[3]);
		else current.disabled = parseDisabled(fieldMatch[3]);
	}
	flush();
	return rows;
}

/**
 * Remote-only service exposing each whitelisted preset's plugin rows.
 * Registered under the Remote namespace `permodeInventory`, method `list()`.
 */
let PermodeInventoryGateway = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _list_decorators;
	return class PermodeInventoryGateway extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_list_decorators = [Remote("list")];
			__esDecorate(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
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
		static inject = ["agentPresets"];
		constructor(ctx, config) {
			super(ctx, "permodeInventory");
			const presetIds = config && Array.isArray(config.presetIds) ? config.presetIds : DEFAULT_PRESET_IDS;
			this.presetIds = presetIds;
			__runInitializers(this, _instanceExtraInitializers);
		}
		/**
		 * Read every whitelisted preset's composition and project its plugin rows.
		 * @returns one plain-object row per preset: { presetId, name, trust, broken?, rows }.
		 */
		async list() {
			const presets = await this.ctx.agentPresets.list();
			const result = [];
			for (const preset of presets) {
				if (!this.presetIds.includes(preset.id)) continue;
				let rows = [];
				if (preset.broken === void 0) {
					try {
						const text = await this.ctx.agentPresets.read(preset.id);
						rows = parseRows(text);
					} catch (_err) {
						rows = [];
					}
				}
				const item = {
					presetId: preset.id,
					name: preset.name ?? preset.id,
					trust: preset.trust,
					rows
				};
				if (preset.broken !== void 0) item.broken = preset.broken;
				result.push(item);
			}
			return result;
		}
	};
})();

export { PermodeInventoryGateway, PermodeInventoryGateway as default };
