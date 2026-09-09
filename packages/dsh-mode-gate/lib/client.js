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
			title: "dsh-mode-gate 阶段权限",
			desc: "展示需求循环各阶段的权限定义，维护模型目录、任务模式默认模型与 bash 禁止命令列表。",
			phasePresetAction: "PRESET_ACTION",
			phaseRequirementRecognition: "REQUIREMENT_RECOGNITION",
			phaseImplement: "IMPLEMENT",
			permPresetAction: "仅 list_preset_actions / submit_preset_action；bash 禁用；命中 skill 直接进入实现阶段",
			permRequirementRecognition: "只读 + 规划 + feature intent 工具；bash 仅允许已声明的只读命令；禁止写文件",
			permImplement: "可写；危险 bash 命令仍需人工授权；feature_intent 目录仍禁止直接写",
			modeLabel: "阶段",
			permLabel: "权限",
			targetLabel: "当前 Target / 阶段",
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
			modelCatalogTitle: "模型目录",
			modelCatalogDesc: "agent 在需求识别阶段会看到这份模型列表与介绍。下方任务模式默认模型会引用这里的 id。",
			modelId: "模型 ID",
			modelName: "名称",
			modelProvider: "Provider",
			modelDescription: "介绍",
			modelIdPlaceholder: "deepseek-v4-flash",
			modelNamePlaceholder: "DeepSeek-V4-Flash",
			modelProviderPlaceholder: "deepseek-official",
			modelDescriptionPlaceholder: "快速轻量模型",
			addModel: "添加模型",
			taskModeTitle: "任务模式默认模型",
			taskModeDesc: "simple / complex 的默认模型；若协议填写 model_override 则覆盖这里的配置。",
			simpleMode: "simple",
			complexMode: "complex",
			taskModeModelPlaceholder: "模型 ID（必须存在于模型目录）",
			saveTaskModes: "保存任务模式",
			saveModelCatalog: "保存模型目录",
			loadModelCatalogFailed: "读取模型目录失败",
			saveModelCatalogFailed: "保存模型目录失败",
			loadTaskModesFailed: "读取任务模式失败",
			saveTaskModesFailed: "保存任务模式失败",
		};
		const en = {
			tab: "Mode Gate",
			title: "dsh-mode-gate phase permissions",
			desc: "Shows the requirement-loop phase permissions, model catalog, task-mode default models, and bash deny-list.",
			phasePresetAction: "PRESET_ACTION",
			phaseRequirementRecognition: "REQUIREMENT_RECOGNITION",
			phaseImplement: "IMPLEMENT",
			permPresetAction: "Only list_preset_actions / submit_preset_action; bash disabled; matched skill jumps to implement",
			permRequirementRecognition: "Read-only + planning + feature intent tools; bash read-only declared commands only; no file writes",
			permImplement: "Write allowed; dangerous bash requires approval; feature_intent directory stays write-protected",
			modeLabel: "Phase",
			permLabel: "Permissions",
			targetLabel: "Current target / phase",
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
			modelCatalogTitle: "Model catalog",
			modelCatalogDesc: "The agent sees this list and its descriptions during requirement recognition. Task-mode defaults reference ids from this table.",
			modelId: "Model ID",
			modelName: "Name",
			modelProvider: "Provider",
			modelDescription: "Description",
			modelIdPlaceholder: "deepseek-v4-flash",
			modelNamePlaceholder: "DeepSeek-V4-Flash",
			modelProviderPlaceholder: "deepseek-official",
			modelDescriptionPlaceholder: "Fast lightweight model",
			addModel: "Add model",
			taskModeTitle: "Task-mode default models",
			taskModeDesc: "Default models for simple / complex. A protocol model_override overrides these.",
			simpleMode: "simple",
			complexMode: "complex",
			taskModeModelPlaceholder: "Model id (must exist in catalog)",
			saveTaskModes: "Save task modes",
			saveModelCatalog: "Save model catalog",
			loadModelCatalogFailed: "Failed to load model catalog",
			saveModelCatalogFailed: "Failed to save model catalog",
			loadTaskModesFailed: "Failed to load task modes",
			saveTaskModesFailed: "Failed to save task modes",
		};

		const PHASES = ["PRESET_ACTION", "REQUIREMENT_RECOGNITION", "IMPLEMENT"];

		/** Read the durable mode-gate state for the current session via the Remote service. */
		function useModeGateState(sessions, api) {
			const list = react.useSyncExternalStore(
				sessions.list.subscribe,
				sessions.list.getSnapshot,
				sessions.list.getSnapshot
			);
			const sessionId = list.current;
			const [state, setState] = react.useState({ phase: "PRESET_ACTION", target: null, goal: null, selectedModel: null });
			const sessionKey = typeof sessionId === "string" ? sessionId : "";

			react.useEffect(() => {
				let current = true;
				let timer;
				const refresh = async () => {
					if (sessionKey === "") {
						if (current) setState({ phase: "PRESET_ACTION", target: null, goal: null, selectedModel: null });
						return;
					}
					try {
						const result = await api().getState({ sessionId: sessionKey });
						if (!current) return;
						if (result && result.ok && result.value) {
							setState(result.value);
						} else if (current) {
							setState({ phase: "PRESET_ACTION", target: null, goal: null, selectedModel: null });
						}
					} catch (_err) {
						if (current) setState({ phase: "PRESET_ACTION", target: null, goal: null, selectedModel: null });
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

		/** Read and update the model catalog through the Remote service. */
		function useModelCatalog(api) {
			const [entries, setEntries] = react.useState([]);
			const [error, setError] = react.useState("");

			const refresh = react.useCallback(async () => {
				try {
					const result = await api().getModelCatalog();
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
					const result = await api().setModelCatalog({ entries: nextEntries });
					if (result && result.ok && result.value && Array.isArray(result.value.entries)) {
						setEntries(result.value.entries);
						setError("");
					} else {
						setError("saveModelCatalogFailed");
					}
				} catch (err) {
					setError(String((err && err.message) || err));
				}
			}, [api]);

			return { entries, error, refresh, save };
		}

		/** Read and update task-mode default models through the Remote service. */
		function useTaskModes(api) {
			const [modes, setModes] = react.useState({ simple: { model: "" }, complex: { model: "" } });
			const [error, setError] = react.useState("");

			const refresh = react.useCallback(async () => {
				try {
					const result = await api().getTaskModes();
					if (result && result.ok && result.value && result.value.modes) {
						setModes(result.value.modes);
					} else {
						setModes({ simple: { model: "" }, complex: { model: "" } });
					}
				} catch (err) {
					setError(String((err && err.message) || err));
				}
			}, [api]);

			react.useEffect(() => { refresh(); }, [refresh]);

			const save = react.useCallback(async (nextModes) => {
				try {
					const result = await api().setTaskModes({ modes: nextModes });
					if (result && result.ok && result.value && result.value.modes) {
						setModes(result.value.modes);
						setError("");
					} else {
						setError("saveTaskModesFailed");
					}
				} catch (err) {
					setError(String((err && err.message) || err));
				}
			}, [api]);

			return { modes, error, refresh, save };
		}

		const PHASE_ROWS = [
			["phasePresetAction", "permPresetAction"],
			["phaseRequirementRecognition", "permRequirementRecognition"],
			["phaseImplement", "permImplement"],
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

		/** Left sidebar footer badge: current phase + declared target. */
		function ModeGateFooterAction(props) {
			const { sessions, api, t, wide } = props;
			const state = useModeGateState(sessions, api);
			const phase = state.phase || "PRESET_ACTION";
			const title = `${t("modeLabel")}: ${phase} / ${t("targetLabel")}: ${state.target ? state.target.target : t("noTarget")}`;
			if (!wide) return react.createElement("span", { style: styles.badge, title }, phase);
			return react.createElement("div", { style: styles.footer },
				react.createElement("span", { style: styles.badge }, phase),
				react.createElement("span", { style: styles.target }, state.target ? state.target.target : t("noTarget")),
			);
		}

		/** Static settings tab: phase permissions, model catalog, task modes, bash deny-list. */
		function ModeGateSettingsTab(props) {
			const { t, api } = props;
			const deny = useBashDenyList(api);
			const modelCatalog = useModelCatalog(api);
			const taskModes = useTaskModes(api);

			const [draft, setDraft] = react.useState([]);
			const [newCommands, setNewCommands] = react.useState("");
			const [newReason, setNewReason] = react.useState("");

			const [modelDraft, setModelDraft] = react.useState([]);
			const [newModel, setNewModel] = react.useState({ id: "", name: "", provider: "deepseek-official", description: "" });

			const [taskDraft, setTaskDraft] = react.useState({ simple: { model: "" }, complex: { model: "" } });

			react.useEffect(() => {
				setDraft((deny.entries || []).map((entry) => ({ ...entry, commands: [...entry.commands] })));
			}, [deny.entries]);

			react.useEffect(() => {
				setModelDraft((modelCatalog.entries || []).map((entry) => ({ ...entry })));
			}, [modelCatalog.entries]);

			react.useEffect(() => {
				setTaskDraft({
					simple: { model: taskModes.modes && taskModes.modes.simple ? taskModes.modes.simple.model : "" },
					complex: { model: taskModes.modes && taskModes.modes.complex ? taskModes.modes.complex.model : "" },
				});
			}, [taskModes.modes]);

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

			const updateModel = (idx, key, value) => setModelDraft((prev) => prev.map((entry, i) => (
				i === idx ? { ...entry, [key]: value } : entry
			)));
			const addModel = async () => {
				if (!newModel.id.trim()) return;
				const next = [...modelDraft, { ...newModel, id: newModel.id.trim() }];
				setModelDraft(next);
				setNewModel({ id: "", name: "", provider: "deepseek-official", description: "" });
				await modelCatalog.save(next);
			};
			const deleteModel = async (idx) => {
				const next = modelDraft.filter((_, i) => i !== idx);
				setModelDraft(next);
				await modelCatalog.save(next);
			};
			const saveModelCatalog = async () => { await modelCatalog.save(modelDraft); };

			const setTaskModel = (mode, value) => setTaskDraft((prev) => ({
				...prev,
				[mode]: { model: value },
			}));
			const saveTaskModes = async () => { await taskModes.save(taskDraft); };

			const head = react.createElement("p", { style: styles.desc }, t("desc"));
			const rows = PHASE_ROWS.map(([phaseKey, permKey]) => react.createElement("tr", { key: phaseKey },
				react.createElement("td", { style: styles.td }, react.createElement("code", { style: styles.code }, t(phaseKey))),
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

			// model catalog
			const modelHead = react.createElement("h3", { style: styles.denyHead }, t("modelCatalogTitle"));
			const modelDesc = react.createElement("p", { style: styles.desc }, t("modelCatalogDesc"));
			const modelRows = modelDraft.map((entry, idx) => react.createElement("tr", { key: entry.id || idx },
				react.createElement("td", { style: styles.td },
					react.createElement("input", { style: styles.input, value: entry.id || '', onChange: (e) => updateModel(idx, 'id', e.target.value) })),
				react.createElement("td", { style: styles.td },
					react.createElement("input", { style: styles.input, value: entry.name || '', onChange: (e) => updateModel(idx, 'name', e.target.value) })),
				react.createElement("td", { style: styles.td },
					react.createElement("input", { style: styles.input, value: entry.provider || '', onChange: (e) => updateModel(idx, 'provider', e.target.value) })),
				react.createElement("td", { style: styles.td },
					react.createElement("input", { style: styles.input, value: entry.description || '', onChange: (e) => updateModel(idx, 'description', e.target.value) })),
				react.createElement("td", { style: styles.td },
					react.createElement("button", { style: styles.button, onClick: () => deleteModel(idx) }, t("delete"))),
			));
			const modelTable = react.createElement("table", { style: styles.table },
				react.createElement("thead", null,
					react.createElement("tr", null,
						react.createElement("th", { style: styles.th }, t("modelId")),
						react.createElement("th", { style: styles.th }, t("modelName")),
						react.createElement("th", { style: styles.th }, t("modelProvider")),
						react.createElement("th", { style: styles.th }, t("modelDescription")),
						react.createElement("th", { style: styles.th }, ""),
					)
				),
				react.createElement("tbody", null, modelRows),
			);
			const modelAddRow = react.createElement("div", { style: styles.addRow },
				react.createElement("input", { style: styles.input, placeholder: t("modelIdPlaceholder"), value: newModel.id, onChange: (e) => setNewModel((prev) => ({ ...prev, id: e.target.value })) }),
				react.createElement("input", { style: styles.input, placeholder: t("modelNamePlaceholder"), value: newModel.name, onChange: (e) => setNewModel((prev) => ({ ...prev, name: e.target.value })) }),
				react.createElement("input", { style: styles.input, placeholder: t("modelProviderPlaceholder"), value: newModel.provider, onChange: (e) => setNewModel((prev) => ({ ...prev, provider: e.target.value })) }),
				react.createElement("input", { style: styles.input, placeholder: t("modelDescriptionPlaceholder"), value: newModel.description, onChange: (e) => setNewModel((prev) => ({ ...prev, description: e.target.value })) }),
				react.createElement("button", { style: styles.button, onClick: addModel }, t("addModel")),
			);
			const modelSaveButton = react.createElement("button", { style: styles.button, onClick: saveModelCatalog }, t("saveModelCatalog"));
			const modelErrorLine = modelCatalog.error ? react.createElement("p", { style: styles.error }, typeof modelCatalog.error === "string" ? modelCatalog.error : t("loadModelCatalogFailed")) : null;

			// task modes
			const taskHead = react.createElement("h3", { style: styles.denyHead }, t("taskModeTitle"));
			const taskDesc = react.createElement("p", { style: styles.desc }, t("taskModeDesc"));
			const taskRow = (labelKey, modeKey) => react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
				react.createElement("code", { style: styles.code }, t(labelKey)),
				react.createElement("input", { style: styles.input, placeholder: t("taskModeModelPlaceholder"), value: taskDraft[modeKey].model, onChange: (e) => setTaskModel(modeKey, e.target.value) }),
			);
			const taskSimple = taskRow("simpleMode", "simple");
			const taskComplex = taskRow("complexMode", "complex");
			const taskSaveButton = react.createElement("button", { style: styles.button, onClick: saveTaskModes }, t("saveTaskModes"));
			const taskErrorLine = taskModes.error ? react.createElement("p", { style: styles.error }, typeof taskModes.error === "string" ? taskModes.error : t("loadTaskModesFailed")) : null;

			// bash deny list
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

			return react.createElement("div", { style: styles.section },
				head,
				table,
				modelHead, modelDesc, modelTable, modelAddRow, modelSaveButton, modelErrorLine,
				taskHead, taskDesc, taskSimple, taskComplex, taskSaveButton, taskErrorLine,
				denyHead, denyDesc, denyTable, addRow, saveButton, errorLine,
			);
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

		function remoteDescriptor(method, codecKind) {
			return {
				id: `dsh-mode-gate#modeGate/${method}`,
				service: "modeGate",
				namespace: "modeGate",
				method,
				invocation: { kind: "direct" },
				parameters: [],
				result: makeCodec(codecKind),
			};
		}
		function remoteArgsDescriptor(method, codecKind) {
			const descriptor = remoteDescriptor(method, codecKind);
			descriptor.parameters = [{
				name: "args",
				wire: "args",
				source: "json",
				codec: makeCodec(`${codecKind}Args`),
			}];
			return descriptor;
		}

		/** Hand-written Typert Remote face for the Host `modeGate` service methods. */
		const TYPERT_REMOTE = {
			package: "dsh-mode-gate",
			descriptors: [
				remoteArgsDescriptor("getState", "GetStateResult"),
				remoteDescriptor("getBashDenyList", "GetBashDenyListResult"),
				remoteArgsDescriptor("setBashDenyList", "SetBashDenyListResult"),
				remoteDescriptor("getModelCatalog", "GetModelCatalogResult"),
				remoteArgsDescriptor("setModelCatalog", "SetModelCatalogResult"),
				remoteDescriptor("getTaskModes", "GetTaskModesResult"),
				remoteArgsDescriptor("setTaskModes", "SetTaskModesResult"),
			],
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
