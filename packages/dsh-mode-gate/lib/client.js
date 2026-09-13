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
			wfIdle: "IDLE（后端不限制，modal 遮罩纯 UI）",
			wfSimpleAction: "SIMPLE-ACTION：PRESET_ACTION → ACTION_EXECUTE → IDLE",
			permSimpleAction: "PRESET_ACTION 只允许 list/submit preset action；ACTION_EXECUTE 可写",
			wfCreate: "CREATE：BASE_READ → REQUIREMENT_RECOGNITION → (RESEARCH → EXECUTE → DEBUG → ACCUMULATION)*n → IDLE",
			permCreate: "BASE_READ/REQUIREMENT_RECOGNITION/RESEARCH 只读；EXECUTE/DEBUG 可写；ACCUMULATION 仅允许 update_project_experience",
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
			wfIdle: "IDLE (backend unrestricted, modal is pure UI)",
			wfSimpleAction: "SIMPLE-ACTION: PRESET_ACTION -> ACTION_EXECUTE -> IDLE",
			permSimpleAction: "PRESET_ACTION only list/submit preset action; ACTION_EXECUTE writable",
			wfCreate: "CREATE: BASE_READ -> REQUIREMENT_RECOGNITION -> (RESEARCH -> EXECUTE -> DEBUG -> ACCUMULATION)*n -> IDLE",
			permCreate: "BASE_READ/REQUIREMENT_RECOGNITION/RESEARCH read-only; EXECUTE/DEBUG writable; ACCUMULATION only update_project_experience",
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

		const PHASES = ["IDLE", "BASE_READ", "REQUIREMENT_RECOGNITION", "RESEARCH", "EXECUTE", "DEBUG", "ACCUMULATION", "PRESET_ACTION", "ACTION_EXECUTE"];

		/** Fresh IDLE state used before the first Remote read resolves (`__loaded` guards auto-switching). */
		function idleState() {
			return { workflowId: "IDLE", phase: "IDLE", target: null, goal: null, selectedModel: null, __loaded: false };
		}

		/** Read the durable mode-gate state for the current session via the Remote service. */
		function useModeGateState(sessions, api) {
			const list = react.useSyncExternalStore(
				sessions.list.subscribe,
				sessions.list.getSnapshot,
				sessions.list.getSnapshot
			);
			const sessionId = list.current;
			const [state, setState] = react.useState(idleState());
			const sessionKey = typeof sessionId === "string" ? sessionId : "";

			react.useEffect(() => {
				let current = true;
				let timer;
				const refresh = async () => {
					if (sessionKey === "") {
						if (current) setState(idleState());
						return;
					}
					try {
						const result = await api().getState({ sessionId: sessionKey });
						if (!current) return;
						if (result && result.ok && result.value) {
							setState({ ...result.value, __loaded: true });
						} else if (current) {
							setState(idleState());
						}
					} catch (_err) {
						if (current) setState(idleState());
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
			["wfIdle", "permImplement"],
			["wfSimpleAction", "permSimpleAction"],
			["wfCreate", "permCreate"],
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
				remoteArgsDescriptor("getWorkflows", "GetWorkflowsResult"),
				remoteArgsDescriptor("selectWorkflow", "SelectWorkflowResult"),
				remoteDescriptor("getBashDenyList", "GetBashDenyListResult"),
				remoteArgsDescriptor("setBashDenyList", "SetBashDenyListResult"),
				remoteDescriptor("getModelCatalog", "GetModelCatalogResult"),
				remoteArgsDescriptor("setModelCatalog", "SetModelCatalogResult"),
				remoteDescriptor("getTaskModes", "GetTaskModesResult"),
				remoteArgsDescriptor("setTaskModes", "SetTaskModesResult"),
			],
		};

		// ── IDLE workflow modal + composer placeholder ───────────────────────
		const modalStore = (() => {
			let hidden = false;
			const listeners = new Set();
			const emit = () => { for (const listener of listeners) listener(); };
			return {
				subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
				getSnapshot: () => hidden,
				set: (next) => { if (next !== hidden) { hidden = next; emit(); } },
				toggle: () => { hidden = !hidden; emit(); },
			};
		})();

		const composerStore = (() => {
			let state = { focused: false, hasText: false, text: "" };
			const listeners = new Set();
			const emit = () => { for (const listener of listeners) listener(); };
			return {
				subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
				getSnapshot: () => state,
				update: (next) => {
					if (next.focused !== state.focused || next.hasText !== state.hasText || next.text !== state.text) {
						state = next;
						emit();
					}
				},
			};
		})();

		function readComposerState() {
			if (typeof document === "undefined") return { focused: false, hasText: false, text: "" };
			const el = document.querySelector("[data-composer-seat] textarea")
				|| document.querySelector("textarea[aria-haspopup]")
				|| document.querySelector("textarea");
			if (!el) return { focused: false, hasText: false, text: "" };
			const value = typeof el.value === "string" ? el.value : "";
			return {
				focused: document.activeElement === el,
				hasText: value.trim().length > 0,
				text: value,
			};
		}

		function useComposerState() {
			return react.useSyncExternalStore(composerStore.subscribe, composerStore.getSnapshot, composerStore.getSnapshot);
		}

		function useIdleModalHidden() {
			return react.useSyncExternalStore(modalStore.subscribe, modalStore.getSnapshot, modalStore.getSnapshot);
		}

		/** Read the workflow buttons for the current session. */
		function useWorkflows(sessions, api) {
			const list = react.useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot, sessions.list.getSnapshot);
			const sessionId = list.current;
			const [data, setData] = react.useState({ workflows: [], workspace: null });
			react.useEffect(() => {
				let current = true;
				let timer;
				const refresh = async () => {
					if (typeof sessionId !== "string") return;
					try {
						const result = await api().getWorkflows({ sessionId });
						if (!current) return;
						if (result && result.ok && result.value) {
							setData({ workflows: result.value.workflows || [], workspace: result.value.workspace || null });
						}
					} catch (_err) { /* keep previous */ }
				};
				refresh();
				timer = setInterval(refresh, 4000);
				return () => { current = false; clearInterval(timer); };
			}, [sessionId, api]);
			return { ...data, sessionId };
		}

		function useIsIdle(sessions, api) {
			const state = useModeGateState(sessions, api);
			return !state.workflowId || state.workflowId === "IDLE";
		}

		/** IDLE + "the durable state has actually been read at least once". */
		function useIdleStatus(sessions, api) {
			const state = useModeGateState(sessions, api);
			return {
				idle: !state.workflowId || state.workflowId === "IDLE",
				loaded: Boolean(state.__loaded),
			};
		}

		/** Prefer the focused/visible composer textarea over cached hidden ones. */
		function findComposerTextarea() {
			if (typeof document === "undefined") return null;
			const all = Array.from(document.querySelectorAll("[data-composer-seat] textarea, [data-input-scroll] textarea"));
			if (all.length === 0) return null;
			const focused = all.find((el) => document.activeElement === el);
			if (focused) return focused;
			const visible = all.filter((el) => el.offsetParent !== null);
			return visible[visible.length - 1] || all[all.length - 1] || null;
		}

		/** Switch a session to a workflow: the /mode command first, the direct Remote write second. */
		async function switchWorkflow(options) {
			const { sessionId, workflowId, getCommands, api } = options;
			if (typeof sessionId !== "string" || typeof workflowId !== "string") return false;
			const face = typeof getCommands === "function" ? getCommands() : null;
			if (face && typeof face.execute === "function") {
				try {
					const outcome = await face.execute(sessionId, `/mode ${workflowId}`);
					if (outcome === undefined || (outcome && outcome.kind !== "error")) return true;
				} catch (_err) { /* fall through to the direct state write */ }
			}
			try {
				const result = await api().selectWorkflow({ sessionId, workflowId });
				return !(result && result.ok === false);
			} catch (_err) {
				return false;
			}
		}

		/** Send the live composer draft as the next message (no-op without the input face). */
		function submitDraft(inputActions) {
			if (inputActions && typeof inputActions.submit === "function") {
				try { inputActions.submit(); return true; } catch (_err) { return false; }
			}
			return false;
		}

		/** Best-effort return to the 对话 tab once the header (and its tab ring) is back. */
		function activateChatView() {
			const click = () => {
				if (typeof document === "undefined") return;
				for (const tab of document.querySelectorAll("[role=\"tab\"]")) {
					if (tab.textContent && tab.textContent.includes("对话")) { tab.click(); return; }
				}
			};
			click();
			for (const delay of [150, 500, 1200]) setTimeout(click, delay);
		}

		/** Workflow button list shared by the tab view and the hero dock. */
		function WorkflowChooser(props) {
			const { workflows, disabled, busy, onPick, compact } = props;
			if (!Array.isArray(workflows) || workflows.length === 0) {
				return react.createElement("div", {
					style: { color: "var(--dsw-alias-label-tertiary)", fontSize: compact ? 12 : 13, textAlign: "center", padding: "8px 0" },
				}, "（未加载到工作流定义，请确认当前会话已绑定工作区）");
			}
			const blocked = Boolean(disabled) || Boolean(busy);
			return react.createElement("div", {
				style: {
					display: "flex", flexDirection: compact ? "row" : "column", flexWrap: "wrap",
					gap: compact ? 8 : 10, width: "100%",
				},
			}, ...workflows.map((wf) => {
				const label = (wf.ui && wf.ui.buttonLabel) || wf.label || wf.id;
				const description = (wf.ui && wf.ui.buttonDescription) || wf.description || "";
				return react.createElement("button", {
					key: wf.id,
					type: "button",
					disabled: blocked,
					title: blocked ? "请先在输入框写下你的需求，再选择工作流" : description,
					onClick: () => { if (!blocked) onPick(wf.id); },
					style: {
						flex: compact ? "0 1 auto" : "none",
						textAlign: "left",
						cursor: blocked ? "not-allowed" : "pointer",
						opacity: blocked ? 0.45 : 1,
						border: "1px solid var(--dsw-alias-border-l2)",
						background: "var(--dsw-alias-bg-module-platform)",
						color: "var(--dsw-alias-label-primary)",
						borderRadius: 12,
						padding: compact ? "8px 12px" : "14px 16px",
						display: "flex", flexDirection: "column", gap: 2,
					},
				},
					react.createElement("span", { style: { fontWeight: 600, fontSize: compact ? 13 : 15 } }, label),
					!compact && react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13 } }, description)
				);
			}));
		}

		/** IDLE workflow chooser as a sibling view of 对话/轨迹. */
		function IdleWorkflowView(props) {
			const { sessions, api, getCommands, inputActions, useInput } = props;
			const { workflows, sessionId } = useWorkflows(sessions, api);
			/* Draft source: the framework session kit first, DOM polling as the backstop. */
			const polled = useComposerState();
			const liveDraft = typeof useInput === "function" ? useInput((state) => state.draft) : null;
			const draft = typeof liveDraft === "string" ? liveDraft : polled.text;
			const hasText = draft.trim().length > 0;
			const [busy, setBusy] = react.useState(false);

			const run = async (workflowId) => {
				if (busy || !hasText) return;
				setBusy(true);
				try {
					await switchWorkflow({ sessionId, workflowId, getCommands, api });
					submitDraft(inputActions);
					activateChatView();
				} finally {
					setBusy(false);
				}
			};

			return react.createElement("div", {
				style: {
					height: "100%", width: "100%", overflowY: "auto",
					padding: "28px 32px", display: "flex", flexDirection: "column",
					alignItems: "center", justifyContent: "center", gap: 12,
				},
			},
				react.createElement("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 20, fontWeight: 600 } }, "选择一个工作流开始"),
				react.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, textAlign: "center" } }, "在下方输入框写下需求，再点工作流：会自动切到该工作流并把这段内容发出去。"),
				react.createElement("div", { style: { width: "100%", maxWidth: 680 } },
					react.createElement(WorkflowChooser, { workflows, disabled: !hasText, busy, onPick: run })
				),
				!hasText && react.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, "输入框为空时按钮不可点击。")
			);
		}

		/** Hero-phase (blank session) chooser pinned above the composer card. */
		function IdleWorkflowDock(props) {
			const { sessions, api, getCommands, inputActions, input } = props;
			const isIdle = useIsIdle(sessions, api);
			const { workflows, sessionId } = useWorkflows(sessions, api);
			const hidden = useIdleModalHidden();
			const polled = useComposerState();
			const [busy, setBusy] = react.useState(false);
			/* Hero only: with a real view ring the 工作流 tab owns this chooser. */
			const blank = Boolean(props.session && props.session.blank);
			const draft = input && typeof input.draft === "string" ? input.draft : polled.text;
			if (!blank || !isIdle || hidden) return null;
			const hasText = draft.trim().length > 0;

			const run = async (workflowId) => {
				if (busy || !hasText) return;
				setBusy(true);
				try {
					await switchWorkflow({ sessionId, workflowId, getCommands, api });
					submitDraft(inputActions);
				} finally {
					setBusy(false);
				}
			};

			return react.createElement("div", {
				style: {
					width: "min(calc(var(--dsh-composer-card-max-width, 780px) + 2 * var(--dsh-composer-side-clearance, 16px)), 100%)",
					alignSelf: "center", boxSizing: "border-box",
					padding: "0 var(--dsh-composer-side-clearance, 16px)",
					display: "flex", flexDirection: "column", gap: 6,
				},
			},
				react.createElement("div", {
					style: { display: "flex", alignItems: "baseline", gap: 8, color: "var(--dsw-alias-label-secondary)", fontSize: 13, paddingLeft: 2 },
				},
					react.createElement("span", { style: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "选择一个工作流开始"),
					react.createElement("span", null, hasText ? "点击后会切换工作流，并把你输入的内容发出去。" : "先写点需求，按钮才会亮起。")
				),
				react.createElement(WorkflowChooser, { workflows, disabled: !hasText, busy, onPick: run })
			);
		}
		/**
		 * Header-right controls. Besides the show/hide button, this component
		 * activates the IDLE workflow tab (via `setView` when the seat supplies it,
		 * otherwise a DOM tab click) and hands the view back to 对话 as soon as the
		 * session leaves IDLE. The hero phase has no tab ring, so the chooser there
		 * rides `conversation.input.dock` instead.
		 */
		function ModeGateHeaderControls(props) {
			const { sessions, api, setView } = props;
			const status = useIdleStatus(sessions, api);
			const isIdle = status.idle;
			const hidden = useIdleModalHidden();
			const prevShown = react.useRef(null);

			react.useEffect(() => {
				const show = isIdle && status.loaded && !hidden;
				const activate = (label) => {
					if (typeof setView === "function") {
						setView(label === "工作流" ? "mode-gate-idle" : "chat");
						return;
					}
					if (typeof document === "undefined") return;
					const tabs = document.querySelectorAll('[role="tab"]');
					for (const tab of tabs) {
						if (tab.textContent && tab.textContent.includes(label)) { tab.click(); return; }
					}
				};
				if (show) {
					// Retry: the view slot may register a tick after this controller mounts.
					activate("工作流");
					const t1 = setTimeout(() => activate("工作流"), 150);
					const t2 = setTimeout(() => activate("工作流"), 600);
					const t3 = setTimeout(() => activate("工作流"), 1400);
					prevShown.current = true;
					return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
				}
				if (prevShown.current === true) activate("对话");
				prevShown.current = false;
				return undefined;
			}, [isIdle, status.loaded, hidden, setView]);

			if (!isIdle) return null;
			return react.createElement("button", {
				onClick: () => modalStore.toggle(),
				title: hidden ? "显示工作流面板" : "隐藏工作流面板",
				style: {
					cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)",
					background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)",
					borderRadius: 8, padding: "3px 8px", fontSize: 12,
				},
			}, hidden ? "显示工作流" : "隐藏工作流");
		}

		/** IDLE-only custom placeholder rendered inside the composer input. */
		function ComposerPlaceholder(props) {
			const { sessions, api, useInput } = props;
			const isIdle = useIsIdle(sessions, api);
			const polled = useComposerState();
			const liveDraft = typeof useInput === "function" ? useInput((state) => state.draft) : null;
			const composer = { hasText: typeof liveDraft === "string" ? liveDraft.trim().length > 0 : polled.hasText };

			react.useEffect(() => {
				if (typeof document === "undefined") return undefined;
				const restore = () => {
					const el = findComposerTextarea();
					if (el && el.dataset.modeGatePlaceholder !== undefined) {
						el.setAttribute("placeholder", el.dataset.modeGatePlaceholder);
						delete el.dataset.modeGatePlaceholder;
					}
					document.body.classList.remove("mode-gate-idle-composer");
				};
				const apply = () => {
					if (!isIdle) { restore(); return; }
					document.body.classList.add("mode-gate-idle-composer");
					const el = findComposerTextarea();
					if (!el) return;
					if (!el.dataset.modeGatePlaceholder) {
						el.dataset.modeGatePlaceholder = el.getAttribute("placeholder") || "";
					}
					if (el.getAttribute("placeholder") !== "") el.setAttribute("placeholder", "");
				};
				apply();
				// The composer textarea can be re-created on session switches.
				const timer = setInterval(apply, 500);
				return () => { clearInterval(timer); restore(); };
			}, [isIdle]);

			if (!isIdle || composer.hasText) return null;
			return react.createElement("div", {
				style: {
					position: "absolute", top: 4, left: 16, right: 16,
					pointerEvents: "none", color: "var(--dsw-alias-label-caption)",
					fontSize: "inherit", lineHeight: "inherit", whiteSpace: "pre-wrap",
				},
			}, "或者你想随便聊点什么？（未来功能：小模型自动路由匹配工作流）");
		}

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

			// Track the focused composer textarea so the IDLE modal can yield when
			// the user starts typing (focus + non-empty draft).
			ctx.effect(() => {
				if (typeof document === "undefined") return () => {};
				let active = null;
				const update = (event) => {
					const target = event && event.target;
					if (target && target.tagName === "TEXTAREA") active = target;
					const el = active || findComposerTextarea();
					if (!el) {
						composerStore.update({ focused: false, hasText: false, text: "" });
						return;
					}
					const value = typeof el.value === "string" ? el.value : "";
					composerStore.update({
						focused: document.activeElement === el,
						hasText: value.trim().length > 0,
						text: value,
					});
				};
				document.addEventListener("input", update, true);
				document.addEventListener("focusin", update, true);
				document.addEventListener("focusout", update, true);
				const timer = setInterval(update, 500);
				update();
				return () => {
					document.removeEventListener("input", update, true);
					document.removeEventListener("focusin", update, true);
					document.removeEventListener("focusout", update, true);
					clearInterval(timer);
				};
			}, "dsh-mode-gate: composer tracking");

			// Hide the native placeholder while the IDLE custom placeholder is mounted.
			ctx.effect(() => {
				if (typeof document === "undefined") return () => {};
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-mode-gate";
				style.textContent = "body.mode-gate-idle-composer textarea::placeholder{color:transparent !important;-webkit-text-fill-color:transparent !important;}";
				document.head.appendChild(style);
				return () => style.remove();
			}, "dsh-mode-gate: placeholder css");

			// IDLE workflow chooser as a sibling view of 对话/轨迹. The header
			// controls auto-switch to it while the session is IDLE.
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "mode-gate-idle",
				order: -1,
				locale: NS,
				label: () => "工作流",
				inject: () => ({ sessions: ctx.get("sessions"), api, getCommands: () => ctx.get("remote.commands") })
			}, IdleWorkflowView));

			// Hero (blank session) has no view ring: the same chooser rides the input
			// dock above the composer card so the first message can pick a workflow.
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "mode-gate-idle-dock",
				order: 5,
				locale: NS,
				inject: () => ({ sessions: ctx.get("sessions"), api, getCommands: () => ctx.get("remote.commands") })
			}, IdleWorkflowDock));

			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "mode-gate-idle-toggle",
				order: 60,
				locale: NS,
				inject: (sessionId, actions) => ({ sessions: ctx.get("sessions"), api, setView: actions && actions.setView })
			}, ModeGateHeaderControls));

			ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
				name: "conversation.input.overlay",
				id: "mode-gate-idle-placeholder",
				order: 20,
				locale: NS,
				inject: () => ({ sessions: ctx.get("sessions"), api })
			}, ComposerPlaceholder));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
