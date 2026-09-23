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
			tabCurrent: "当前配置",
			tabAllModes: "所有模式",
			tabAliases: "模型代号映射",
			restrictionRef: "引用限制",
			restrictionNone: "无（不引用）",
			restrictionView: "展开查看",
			restrictionHide: "收起",
			restrictionEmpty: "暂无限制套件，先去「限制」tab 新建",
			tabRestrictions: "限制",
			tabCompression: "模型压缩上下文",
			title: "dsh-mode-gate 阶段权限",
			desc: "维护各工作流阶段的 Prompt 与自动命令指引，以及模型目录、任务模式默认模型和 bash 禁止命令列表。",
			phasePresetAction: "PRESET_ACTION",
			phaseRequirementRecognition: "REQUIREMENT_RECOGNITION",
			phaseImplement: "IMPLEMENT",
			permPresetAction: "仅 list_preset_actions / submit_preset_action；bash 禁用；命中 skill 直接进入实现阶段",
			permRequirementRecognition: "只读 + 规划 + feature intent 工具；bash 仅允许只读命令；禁止写文件",
			permImplement: "可写；危险 bash 命令仍需人工授权；feature_intent 目录仍禁止直接写",
			wfIdle: "IDLE（后端不限制，modal 遮罩纯 UI）",
			wfSimpleAction: "SIMPLE-ACTION：PRESET_ACTION → ACTION_EXECUTE → IDLE",
			permSimpleAction: "PRESET_ACTION 只允许 list/submit preset action；ACTION_EXECUTE 可写",
			wfCreate: "CREATE：INIT → REQUIREMENT_RECOGNITION → (RESEARCH → EXECUTE → DEBUG → ACCUMULATION)*n → IDLE",
			permCreate: "INIT/REQUIREMENT_RECOGNITION/RESEARCH 只读且不看代码；EXECUTE/DEBUG 可写；ACCUMULATION 不写长期记忆，直接提交",
			modeLabel: "阶段",
			permLabel: "权限",
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
			saveModelCatalog: "保存模型目录",
			loadModelCatalogFailed: "读取模型目录失败",
			saveModelCatalogFailed: "保存模型目录失败",
			modelAliasesTitle: "模型代号映射",
			modelAliasesDesc: "工作流阶段只引用左侧的字符串代号；右侧选择该代号实际使用的具体模型（列出当前所有 provider 的全部模型）。改这里即可换模型，无需改工作流配置。",
			restrictionDesc: "一套限制为黑名单（禁命令/禁 skill）或白名单（仅允许某些 skill）之一，两者互斥。INIT 等阶段可引用某套限制复用。",
			restrictionBlacklist: "黑名单",
			restrictionWhitelist: "白名单",
			restrictionDenyCommands: "禁命令（逗号分隔动词）",
			restrictionDenySkills: "禁 skill（逗号分隔）",
			restrictionAllowSkills: "仅允许的 skill（逗号分隔）",
			restrictionNewId: "新限制 id",
			restrictionNewLabel: "展示名",
			modelAliasColumn: "代号",
			modelAliasTargetColumn: "具体模型",
			modelThinkingAliasColumn: "思考等级",
			modelAliasPlaceholder: "kimi-code",
			addModelAlias: "添加映射",
			saveModelAliases: "保存代号映射",
			loadProviderModelsFailed: "读取 provider 模型列表失败",
			workflowSettingsTitle: "工作流阶段设置",
			workflowSettingsDesc: "点击工作流展开阶段表格。Prompt 会作为该阶段的 runtime context 注入并喂给 Agent（即使当前 agent preset 使用 complete persona 也能到达模型）；开启自动命令指引后，系统会根据该阶段的 goal 动态生成需要执行/提交的命令清单。",
			expandWorkflow: "展开",
			collapseWorkflow: "收起",
			phaseColumn: "阶段",
			promptColumn: "阶段 Prompt（可编辑）",
			autoGuideColumn: "自动生成命令指引",
			ignorePromptColumn: "忽略 prompt（不注入用户/自动 prompt）",
			autoGuidePreview: "自动生成内容预览",
			modelThinkingColumn: "模型 / thinking",
			workflowModelPlaceholder: "模型代号（留空用默认）",
			effortDefault: "默认",
			effortHigh: "high",
			effortLow: "low",
			effortNo: "no",
			effortMax: "max",
			saveWorkflow: "保存该工作流设置",
			loadWorkflowSettingsFailed: "读取工作流设置失败",
			saveWorkflowSettingsFailed: "保存工作流设置失败",
			workflowSettingsSaveSuccess: "已保存",
			workflowRefsTitle: "工作流与阶段引用",
			workflowRefsDesc: "点击工作流展开它引用的阶段；每个阶段对应「所有模式」里的一个模式。",
			openStage: "打开对应阶段",
			allModesTitle: "所有模式",
			allModesDesc: "点击任意模式展开/收起阶段卡片；这些模式被工作流以 stageId 引用。",
			workflowOfMode: "所属工作流",
			progressRequirementsTitle: "进展需求",
			reqAdd: "＋ 添加需求",
			reqAddFile: "查看过某个文件",
			reqAddSkill: "执行过某个 skill",
			reqFilePathPlaceholder: "文件路径，如 src/index.js",
			reqSkillNamePlaceholder: "skill / 工具名称，如 todo_write",
			reqTrueField: "只有 skill 返回指定 true field 才算通过",
			reqTrueFieldPlaceholder: "字段名，如 ok",
			reqDelete: "删除",
			pendingProtocolTitle: "需求识别协议待确认",
			pendingProtocolDesc: "Agent 已提交以下阶段进展，请确认是否接受。接受后进入功能列表更新阶段；在下方输入框发送任意内容将视为拒绝，Agent 会继续修改需求理解。",
			accept: "接受",
			accepting: "正在接受…",
			approveSuccess: "已接受，进入下一阶段",
			approveFailed: "接受失败",
			fieldTaskMode: "任务模式",
			fieldFeatureIntentFile: "Feature intent 文件",
			fieldSummary: "任务摘要",
			fieldUserWords: "用户原话",
			fieldUnderstanding: "Agent 理解",
			fieldUserVisibleBehavior: "用户可见行为",
			fieldFeatureIntent: "功能意图",
			fieldChecklist: "可验收 Checklist",
			fieldModel: "模型",
			pendingPlaceholder: "在这里输入内容并发送以修改需求或者评论理解。",
		};
		const en = {
			tab: "Mode Gate",
			tabCurrent: "Current",
			tabAllModes: "All modes",
			tabAliases: "Model codenames",
			restrictionRef: "Referenced restriction",
			restrictionNone: "None",
			restrictionView: "View",
			restrictionHide: "Collapse",
			restrictionEmpty: "No restriction sets yet — create one in the Restrictions tab",
			tabRestrictions: "Restrictions",
			tabCompression: "Compression context",
			title: "dsh-mode-gate phase permissions",
			desc: "Edit per-workflow phase prompts and auto command guides, plus model catalog, task-mode default models, and bash deny-list.",
			phasePresetAction: "PRESET_ACTION",
			phaseRequirementRecognition: "REQUIREMENT_RECOGNITION",
			phaseImplement: "IMPLEMENT",
			permPresetAction: "Only list_preset_actions / submit_preset_action; bash disabled; matched skill jumps to implement",
			permRequirementRecognition: "Read-only + planning + feature intent tools; bash read-only commands only; no file writes",
			permImplement: "Write allowed; dangerous bash requires approval; feature_intent directory stays write-protected",
			wfIdle: "IDLE (backend unrestricted, modal is pure UI)",
			wfSimpleAction: "SIMPLE-ACTION: PRESET_ACTION -> ACTION_EXECUTE -> IDLE",
			permSimpleAction: "PRESET_ACTION only list/submit preset action; ACTION_EXECUTE writable",
			wfCreate: "CREATE: INIT -> REQUIREMENT_RECOGNITION -> (RESEARCH -> EXECUTE -> DEBUG -> ACCUMULATION)*n -> IDLE",
			permCreate: "INIT/REQUIREMENT_RECOGNITION/RESEARCH read-only without code reading; EXECUTE/DEBUG writable; ACCUMULATION does not write long-term memory, submit directly",
			modeLabel: "Phase",
			permLabel: "Permissions",
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
			saveModelCatalog: "Save model catalog",
			loadModelCatalogFailed: "Failed to load model catalog",
			saveModelCatalogFailed: "Failed to save model catalog",
			modelAliasesTitle: "Model codename map",
			modelAliasesDesc: "Workflow phases reference the codename on the left; pick the concrete model each codename uses on the right (lists every model from every provider). Change the mapping to switch models without touching workflow config.",
			restrictionDesc: "One restriction set is either a blacklist (deny commands/skills) or a whitelist (only allow listed skills), mutually exclusive. Stages like INIT can reference a set for reuse.",
			restrictionBlacklist: "Blacklist",
			restrictionWhitelist: "Whitelist",
			restrictionDenyCommands: "Denied commands (comma-separated verbs)",
			restrictionDenySkills: "Denied skills (comma-separated)",
			restrictionAllowSkills: "Allowed skills only (comma-separated)",
			restrictionNewId: "New restriction id",
			restrictionNewLabel: "Display name",
			modelAliasColumn: "Codename",
			modelAliasTargetColumn: "Concrete model",
			modelThinkingAliasColumn: "Thinking level",
			modelAliasPlaceholder: "kimi-code",
			addModelAlias: "Add mapping",
			saveModelAliases: "Save codename map",
			loadProviderModelsFailed: "Failed to load provider models",
			workflowSettingsTitle: "Workflow phase settings",
			workflowSettingsDesc: "Expand a workflow to edit each phase prompt. The prompt is injected as runtime context for the agent (it reaches the model even when the agent preset uses a complete persona); enable auto command guide and the system generates the required tool/submit commands from the phase goal.",
			expandWorkflow: "Expand",
			collapseWorkflow: "Collapse",
			phaseColumn: "Phase",
			promptColumn: "Phase prompt (editable)",
			autoGuideColumn: "Auto command guide",
			ignorePromptColumn: "Ignore prompt (no user/auto prompt injected)",
			autoGuidePreview: "Generated guide preview",
			modelThinkingColumn: "Model / thinking",
			workflowModelPlaceholder: "model codename (empty = default)",
			effortDefault: "default",
			effortHigh: "high",
			effortLow: "low",
			effortNo: "no",
			effortMax: "max",
			saveWorkflow: "Save workflow settings",
			loadWorkflowSettingsFailed: "Failed to load workflow settings",
			saveWorkflowSettingsFailed: "Failed to save workflow settings",
			workflowSettingsSaveSuccess: "Saved",
			workflowRefsTitle: "Workflow and stage references",
			workflowRefsDesc: "Expand a workflow to see the stages it references; each stage maps to one mode in All modes.",
			openStage: "Open stage",
			allModesTitle: "All modes",
			allModesDesc: "Click any mode to expand/collapse its stage card; workflows reference these modes by stageId.",
			workflowOfMode: "Workflow",
			progressRequirementsTitle: "Progress requirements",
			reqAdd: "+ Add requirement",
			reqAddFile: "Viewed a file",
			reqAddSkill: "Executed a skill",
			reqFilePathPlaceholder: "File path, e.g. src/index.js",
			reqSkillNamePlaceholder: "Skill / tool name, e.g. todo_write",
			reqTrueField: "Only pass when the skill returns the specified true field",
			reqTrueFieldPlaceholder: "Field name, e.g. ok",
			reqDelete: "Delete",
			pendingProtocolTitle: "Requirement protocol pending",
			pendingProtocolDesc: "The agent submitted the following phase progress. Accept to enter the feature-list update phase; sending any message in the composer rejects it and the agent continues revising the requirement.",
			accept: "Accept",
			accepting: "Accepting…",
			approveSuccess: "Accepted, moving to next phase",
			approveFailed: "Failed to accept",
			fieldTaskMode: "Task mode",
			fieldFeatureIntentFile: "Feature intent file",
			fieldSummary: "Summary",
			fieldUserWords: "User words",
			fieldUnderstanding: "Agent understanding",
			fieldUserVisibleBehavior: "User-visible behavior",
			fieldFeatureIntent: "Feature intent",
			fieldChecklist: "Checklist",
			fieldModel: "Model",
			pendingPlaceholder: "Type here and send to revise the requirement or comment on the understanding.",
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

		/** Read and update the codename -> concrete model alias map through the Remote service. */
		function useModelAliases(api) {
			const [entries, setEntries] = react.useState([]);
			const [error, setError] = react.useState("");

			const refresh = react.useCallback(async () => {
				try {
					const result = await api().getModelAliases();
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
					const result = await api().setModelAliases({ entries: nextEntries });
					if (result && result.ok && result.value && Array.isArray(result.value.entries)) {
						setEntries(result.value.entries);
						setError("");
					} else {
						setError("saveModelAliasesFailed");
					}
				} catch (err) {
					setError(String((err && err.message) || err));
				}
			}, [api]);

			return { entries, error, refresh, save };
		}

		/**
		 * Load the Host-generation model catalog (all providers -> all models)
		 * for populating the alias-target dropdown. Returns [] on failure.
		 */
		function useProviderModels(getModelCatalog) {
			const [groups, setGroups] = react.useState([]);
			const [error, setError] = react.useState("");

			const refresh = react.useCallback(async () => {
				if (typeof getModelCatalog !== "function") { setGroups([]); return; }
				try {
					const response = await getModelCatalog();
					const value = response && response.value ? response.value : response;
					if (value && Array.isArray(value.groups)) {
						setGroups(value.groups.map((group) => ({
							id: group.id,
							models: Array.isArray(group.models) ? group.models.map((model) => ({ id: model.id, name: model.name, reasoning: model.reasoning || null })) : [],
						})));
					} else {
						setGroups([]);
					}
				} catch (err) {
					setError(String((err && err.message) || err));
					setGroups([]);
				}
			}, [getModelCatalog]);

			react.useEffect(() => { refresh(); }, [refresh]);

			return { groups, error, refresh };
		}
		function useWorkflowSettings(api) {
			const [data, setData] = react.useState({ workflows: [], overrides: {}, workspace: null });
			const [error, setError] = react.useState("");
			const [savedAt, setSavedAt] = react.useState(0);

			const refresh = react.useCallback(async () => {
				try {
					const result = await api().getWorkflowSettings();
					if (result && result.ok && result.value) {
						setData({
							workflows: Array.isArray(result.value.workflows) ? result.value.workflows : [],
							overrides: result.value.overrides || {},
							workspace: result.value.workspace || null,
						});
					} else {
						setError("loadWorkflowSettingsFailed");
					}
				} catch (err) {
					setError(String((err && err.message) || err));
				}
			}, [api]);

			const saveOverride = react.useCallback(async (workflowId, stateId, patch) => {
				try {
					const result = await api().setWorkflowOverride({ workflowId, stateId, patch });
					if (result && result.ok === false) {
						setError(String(result.error || "saveWorkflowSettingsFailed"));
						return false;
					}
					setError("");
					setSavedAt(Date.now());
					return true;
				} catch (err) {
					setError(String((err && err.message) || err));
					return false;
				}
			}, [api]);

			const saveStage = react.useCallback(async (stageId, patch) => {
				try {
					const result = await api().setStageOverride({ stageId, patch });
					if (result && result.ok === false) {
						setError(String(result.error || "saveWorkflowSettingsFailed"));
						return false;
					}
					setError("");
					setSavedAt(Date.now());
					return true;
				} catch (err) {
					setError(String((err && err.message) || err));
					return false;
				}
			}, [api]);


			react.useEffect(() => {
				refresh();
				const timer = setInterval(refresh, 4000);
				return () => clearInterval(timer);
			}, [refresh]);

			return { ...data, error, refresh, saveOverride, saveStage, savedAt };
		}


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

		/** Folder-style workflow settings: click to expand, editable per-state prompt + auto-guide toggle. */
		function WorkflowSettingsView(props) {
			const { t, api } = props;
			const settings = useWorkflowSettings(api);
			const [expanded, setExpanded] = react.useState({});
			const [drafts, setDrafts] = react.useState({});
			const initialized = react.useRef(false);

			react.useEffect(() => {
				if (!Array.isArray(settings.workflows) || settings.workflows.length === 0) return;
				if (initialized.current) return;
				const next = {};
				for (const wf of settings.workflows) {
					next[wf.id] = (wf.states || []).map((state) => {
						const override = settings.overrides && settings.overrides[wf.id] && settings.overrides[wf.id][state.id]
							? settings.overrides[wf.id][state.id]
							: null;
						const defaultAuto = Boolean(state.goalRef || state.hasTransitions);
						return {
							stateId: state.id,
							prompt: override && typeof override.prompt === "string" ? override.prompt : (state.prompt || ""),
							autoGuide: override && typeof override.autoGuide === "boolean" ? override.autoGuide : defaultAuto,
							ignorePrompt: Boolean(override && override.ignorePrompt === true),
							model: override && typeof override.model === "string" ? override.model : (typeof state.model === "string" ? state.model : ""),
							reasoningEffort: override && typeof override.reasoningEffort === "string"
								? override.reasoningEffort
								: (typeof state.reasoningEffort === "string" ? state.reasoningEffort : ""),
						};
					});
				}
				setDrafts(next);
				initialized.current = true;
			}, [settings.workflows, settings.overrides]);

			const updateDraft = (workflowId, index, patch) => {
				setDrafts((prev) => {
					const wfDrafts = prev[workflowId] || [];
					return { ...prev, [workflowId]: wfDrafts.map((row, i) => (i === index ? { ...row, ...patch } : row)) };
				});
			};

			const saveWorkflow = async (workflowId) => {
				const rows = drafts[workflowId] || [];
				for (const row of rows) {
					await settings.saveOverride(workflowId, row.stateId, {
						prompt: row.prompt,
						autoGuide: row.autoGuide,
						ignorePrompt: Boolean(row.ignorePrompt),
						model: row.model,
						reasoningEffort: row.reasoningEffort,
					});
				}
				await settings.refresh();
			};

			const settingsError = typeof settings.error === "string" && settings.error
				? (settings.error === "loadWorkflowSettingsFailed" || settings.error === "saveWorkflowSettingsFailed"
					? t(settings.error)
					: settings.error)
				: "";

			if (settings.workflows.length === 0) {
				return react.createElement("div", null,
					react.createElement("h3", { style: styles.denyHead }, t("workflowSettingsTitle")),
					react.createElement("p", { style: styles.desc }, t("workflowSettingsDesc")),
					react.createElement("p", { style: styles.error }, settingsError || t("loadWorkflowSettingsFailed")),
				);
			}

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
				react.createElement("h3", { style: styles.denyHead }, t("workflowSettingsTitle")),
				react.createElement("p", { style: styles.desc }, t("workflowSettingsDesc")),
				settings.workflows.map((wf) => {
					const isOpen = Boolean(expanded[wf.id]);
					const rows = drafts[wf.id] || [];
					return react.createElement("div", {
						key: wf.id,
						style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, overflow: "hidden" },
					},
						react.createElement("button", {
							type: "button",
							onClick: () => setExpanded((prev) => ({ ...prev, [wf.id]: !prev[wf.id] })),
							style: { ...styles.button, width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 8, border: "none", borderRadius: 0, padding: "10px 12px" },
						},
							react.createElement("span", { style: { fontSize: 12, lineHeight: "18px" } }, isOpen ? "▾" : "▸"),
							react.createElement("code", { style: styles.code }, wf.label || wf.id),
							react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, wf.description || wf.id),
						),
						isOpen && react.createElement("table", { style: { ...styles.table, border: "none", borderRadius: 0 } },
							react.createElement("thead", null,
								react.createElement("tr", null,
									react.createElement("th", { style: styles.th }, t("phaseColumn")),
									react.createElement("th", { style: styles.th }, t("promptColumn")),
									react.createElement("th", { style: styles.th }, t("autoGuideColumn")),
									react.createElement("th", { style: styles.th }, t("ignorePromptColumn")),
									react.createElement("th", { style: styles.th }, t("modelThinkingColumn")),
								),
							),
							react.createElement("tbody", null,
								rows.map((row, idx) => react.createElement("tr", { key: row.stateId },
									react.createElement("td", { style: styles.td },
										react.createElement("code", { style: styles.code }, row.stateId),
									),
									react.createElement("td", { style: styles.td },
										react.createElement("textarea", {
											style: { ...styles.input, minHeight: 72, resize: "vertical" },
											value: row.prompt,
											onChange: (e) => updateDraft(wf.id, idx, { prompt: e.target.value }),
										}),
									),
									react.createElement("td", { style: { ...styles.td, textAlign: "center" } },
										react.createElement("input", {
											type: "checkbox",
											checked: Boolean(row.autoGuide),
											onChange: (e) => updateDraft(wf.id, idx, { autoGuide: e.target.checked }),
										}),
									),
									react.createElement("td", { style: { ...styles.td, textAlign: "center" } },
										react.createElement("input", {
											type: "checkbox",
											checked: Boolean(row.ignorePrompt),
											onChange: (e) => updateDraft(wf.id, idx, { ignorePrompt: e.target.checked }),
										}),
									),
									react.createElement("td", { style: styles.td },
										react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
											react.createElement("input", {
												style: styles.input,
												placeholder: t("workflowModelPlaceholder"),
												value: row.model || "",
												onChange: (e) => updateDraft(wf.id, idx, { model: e.target.value }),
											}),
											react.createElement("select", {
												style: styles.input,
												value: row.reasoningEffort || "",
												onChange: (e) => updateDraft(wf.id, idx, { reasoningEffort: e.target.value }),
											},
												react.createElement("option", { value: "" }, t("effortDefault")),
												react.createElement("option", { value: "high" }, t("effortHigh")),
												react.createElement("option", { value: "low" }, t("effortLow")),
												react.createElement("option", { value: "no" }, t("effortNo")),
												react.createElement("option", { value: "max" }, t("effortMax")),
											),
										),
									),
								)),
							),
							react.createElement("div", { style: { padding: "8px 10px", display: "flex", gap: 8, alignItems: "center" } },
								react.createElement("button", { style: styles.button, onClick: () => saveWorkflow(wf.id) }, t("saveWorkflow")),
								settings.savedAt ? react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, t("workflowSettingsSaveSuccess")) : null,
							),
						),
					);
				}),
				settingsError ? react.createElement("p", { style: styles.error }, settingsError) : null,
			);
		}

		/** Left sidebar footer badge: phase only; mode+goal now live in the input dock. */
		function ModeGateFooterAction(props) {
			const { sessions, api, t, wide } = props;
			const state = useModeGateState(sessions, api);
			const phase = state.phase || "PRESET_ACTION";
			const title = `${t("modeLabel")}: ${phase}`;
			if (!wide) return react.createElement("span", { style: styles.badge, title }, phase);
			return react.createElement("div", { style: styles.footer },
				react.createElement("span", { style: styles.badge, title }, phase),
			);
		}

		/** Workflow → stage references shown in the「当前配置」tab. */
		function WorkflowReferenceListView(props) {
			const { t, api, onOpenStage } = props;
			const settings = useWorkflowSettings(api);
			const [expanded, setExpanded] = react.useState({});

			if (!Array.isArray(settings.workflows) || settings.workflows.length === 0) {
				return react.createElement("div", null,
					react.createElement("h3", { style: styles.denyHead }, t("workflowRefsTitle")),
					react.createElement("p", { style: styles.desc }, t("workflowRefsDesc")),
					react.createElement("p", { style: styles.error }, t("loadWorkflowSettingsFailed")),
				);
			}

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
				react.createElement("h3", { style: styles.denyHead }, t("workflowRefsTitle")),
				react.createElement("p", { style: styles.desc }, t("workflowRefsDesc")),
				settings.workflows.map((wf) => {
					const isOpen = Boolean(expanded[wf.id]);
					return react.createElement("div", {
						key: wf.id,
						style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, overflow: "hidden" },
					},
						react.createElement("button", {
							type: "button",
							onClick: () => setExpanded((prev) => ({ ...prev, [wf.id]: !prev[wf.id] })),
							style: { ...styles.button, width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 8, border: "none", borderRadius: 0, padding: "10px 12px" },
						},
							react.createElement("span", { style: { fontSize: 12, lineHeight: "18px" } }, isOpen ? "▾" : "▸"),
							react.createElement("code", { style: styles.code }, wf.label || wf.id),
							react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, wf.description || wf.id),
						),
						isOpen && react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px" } },
							(wf.states || []).map((state) => {
								const stageId = state.stageId || `${wf.id}.${state.id}`;
								const label = state.label || state.id;
								return react.createElement("div", {
									key: state.id,
									style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 8 },
								},
									react.createElement("code", { style: styles.code }, stageId),
									react.createElement("span", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 13, flex: 1 } }, label),
									react.createElement("button", {
										type: "button",
										style: styles.button,
										onClick: () => { if (typeof onOpenStage === "function") onOpenStage(stageId); },
									}, t("openStage")),
								);
							}),
							(wf.states || []).length === 0 && react.createElement("p", { style: styles.desc }, "（无阶段引用）"),
						),
					);
				}),
			);
		}


		/** Static settings tab: workflow → stage references + bash deny-list. */
		function ModeGateSettingsTab(props) {
			const { t, api, onOpenStage } = props;
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
			const workflowRefs = react.createElement(WorkflowReferenceListView, { t, api, onOpenStage });
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
				workflowRefs,
				denyHead, denyDesc, denyTable, addRow, saveButton, errorLine,
			);
		}

		/** 「所有模式」tab：平铺展示所有阶段（模式）列表。 */
		function ModeGateAllModesTab(props) {
			const { t, api, focusStageId } = props;
			return react.createElement(ModeGateStageCardsView, { t, api, focusStageId });
		}

		/** 「所有模式」：把每个工作流引用的阶段拉平为模式 list，点击模式展开阶段卡片。 */
		function ModeGateStageCardsView(props) {
			const { t, api, focusStageId } = props;
			const settings = useWorkflowSettings(api);
			const [expanded, setExpanded] = react.useState({});
			const [drafts, setDrafts] = react.useState({});
			const initialized = react.useRef(false);

			const modes = react.useMemo(() => {
				const list = [];
				for (const wf of settings.workflows) {
					for (const state of wf.states || []) {
						list.push({
							stageId: state.stageId || wf.id + "." + state.id,
							workflowId: wf.id,
							workflowLabel: wf.label || wf.id,
							stateId: state.id,
							stateLabel: state.label || state.id,
							stateDescription: state.description || "",
							prompt: state.prompt || "",
							autoGuide: typeof state.autoGuide === "boolean" ? state.autoGuide : Boolean(state.goalRef || state.hasTransitions),
							ignorePrompt: state.ignorePrompt === true,
							autoGuideText: typeof state.autoGuideText === "string" ? state.autoGuideText : "",
							model: typeof state.model === "string" ? state.model : "",
							reasoningEffort: typeof state.reasoningEffort === "string" ? state.reasoningEffort : "",
							restriction: typeof state.restriction === "string" ? state.restriction : "",
							requirements: (Array.isArray(state.requirements) ? state.requirements : [])
								.filter((requirement) => requirement && (requirement.kind === "file" || requirement.kind === "skill"))
								.map((requirement) => requirement.kind === "file"
									? { kind: "file", path: requirement.path || "" }
									: { kind: "skill", name: requirement.name || "", requireTrueField: Boolean(requirement.requireTrueField), trueField: requirement.trueField || "ok" }),
						});
					}
				}
				return list;
			}, [settings.workflows]);

			react.useEffect(() => {
				if (modes.length === 0) return;
				if (initialized.current) return;
				const next = {};
				for (const mode of modes) {
					next[mode.stageId] = { ...mode };
				}
				setDrafts(next);
				initialized.current = true;
			}, [modes]);

			react.useEffect(() => {
				if (typeof focusStageId !== "string" || !focusStageId) return;
				setExpanded((prev) => ({ ...prev, [focusStageId]: true }));
				const timer = setTimeout(() => {
					if (typeof document === "undefined") return;
					const el = document.getElementById("mode-gate-stage-" + focusStageId);
					if (el && typeof el.scrollIntoView === "function") {
						el.scrollIntoView({ block: "start", behavior: "smooth" });
					}
				}, 120);
				return () => clearTimeout(timer);
			}, [focusStageId]);

			const updateDraft = (stageId, patch) => {
				setDrafts((prev) => {
					const row = prev[stageId] || {};
					return { ...prev, [stageId]: { ...row, ...patch } };
				});
			};

			const saveStage = async (stageId) => {
				const row = drafts[stageId];
				if (!row) return;
				await settings.saveStage(stageId, {
					prompt: row.prompt,
					autoGuide: row.autoGuide,
					ignorePrompt: Boolean(row.ignorePrompt),
					model: row.model,
					reasoningEffort: row.reasoningEffort,
					requirements: row.requirements || [],
					restriction: row.restriction || "",
				});
				await settings.refresh();
			};
			const restrictionStore = useRestrictions(api);
			const [restrictionOpen, setRestrictionOpen] = react.useState({});

			const settingsError = typeof settings.error === "string" && settings.error
				? (settings.error === "loadWorkflowSettingsFailed" || settings.error === "saveWorkflowSettingsFailed"
					? t(settings.error)
					: settings.error)
				: "";

			const updateRequirement = (stageId, reqIndex, patch) => {
				setDrafts((prev) => {
					const row = prev[stageId] || {};
					const requirements = (row.requirements || []).map((requirement, j) => (j === reqIndex ? { ...requirement, ...patch } : requirement));
					return { ...prev, [stageId]: { ...row, requirements } };
				});
			};

			const addRequirement = (stageId, kind) => {
				setDrafts((prev) => {
					const row = prev[stageId] || {};
					const requirement = kind === "file"
						? { kind: "file", path: "" }
						: { kind: "skill", name: "", requireTrueField: false, trueField: "ok" };
					return { ...prev, [stageId]: { ...row, requirements: [...(row.requirements || []), requirement] } };
				});
			};

			const removeRequirement = (stageId, reqIndex) => {
				setDrafts((prev) => {
					const row = prev[stageId] || {};
					return { ...prev, [stageId]: { ...row, requirements: (row.requirements || []).filter((_requirement, j) => j !== reqIndex) } };
				});
			};

			const effortSelect = (value, onChange) => react.createElement("select", {
				style: styles.input,
				value: value || "",
				onChange: (e) => onChange(e.target.value),
			},
				react.createElement("option", { value: "" }, t("effortDefault")),
				react.createElement("option", { value: "high" }, t("effortHigh")),
				react.createElement("option", { value: "low" }, t("effortLow")),
				react.createElement("option", { value: "no" }, t("effortNo")),
				react.createElement("option", { value: "max" }, t("effortMax")),
			);

			if (modes.length === 0) {
				return react.createElement("div", null,
					react.createElement("h3", { style: styles.denyHead }, t("allModesTitle")),
					react.createElement("p", { style: styles.desc }, t("allModesDesc")),
					react.createElement("p", { style: styles.error }, settingsError || t("loadWorkflowSettingsFailed")),
				);
			}

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
				react.createElement("h3", { style: styles.denyHead }, t("allModesTitle")),
				react.createElement("p", { style: styles.desc }, t("allModesDesc")),
				modes.map((mode) => {
					const isOpen = Boolean(expanded[mode.stageId]);
					const row = drafts[mode.stageId] || mode;
					return react.createElement("div", {
						key: mode.stageId,
						id: "mode-gate-stage-" + mode.stageId,
						style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, overflow: "hidden" },
					},
						react.createElement("button", {
							type: "button",
							onClick: () => setExpanded((prev) => ({ ...prev, [mode.stageId]: !prev[mode.stageId] })),
							style: { ...styles.button, width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 8, border: "none", borderRadius: 0, padding: "10px 12px" },
						},
							react.createElement("span", { style: { fontSize: 12, lineHeight: "18px" } }, isOpen ? "▾" : "▸"),
							react.createElement("code", { style: styles.code }, mode.stageId),
							react.createElement("span", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 13 } }, mode.stateLabel),
							react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, t("workflowOfMode") + ": " + mode.workflowLabel),
						),
						isOpen && react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10, padding: "10px 12px" } },
							mode.stateDescription ? react.createElement("p", { style: { ...styles.desc, margin: 0 } }, mode.stateDescription) : null,
							react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
								react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("promptColumn")),
								react.createElement("textarea", {
									style: { ...styles.input, minHeight: 72, resize: "vertical" },
									value: row.prompt,
									onChange: (e) => updateDraft(mode.stageId, { prompt: e.target.value }),
								}),
							),
							react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
								react.createElement("input", {
									type: "checkbox",
									checked: Boolean(row.autoGuide),
									onChange: (e) => updateDraft(mode.stageId, { autoGuide: e.target.checked }),
								}),
								react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("autoGuideColumn")),
							),
							react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
								react.createElement("input", {
									type: "checkbox",
									checked: Boolean(row.ignorePrompt),
									onChange: (e) => updateDraft(mode.stageId, { ignorePrompt: e.target.checked }),
								}),
								react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("ignorePromptColumn")),
							),
							react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
								react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("autoGuidePreview")),
								react.createElement("textarea", {
									style: { ...styles.input, minHeight: 64, resize: "vertical", color: "var(--dsw-alias-label-secondary)" },
									value: row.autoGuideText || "",
									readOnly: true,
								}),
							),
							react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
								react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("modelThinkingColumn")),
								react.createElement("input", {
									style: styles.input,
									placeholder: t("workflowModelPlaceholder"),
									value: row.model || "",
									onChange: (e) => updateDraft(mode.stageId, { model: e.target.value }),
								}),
								effortSelect(row.reasoningEffort, (value) => updateDraft(mode.stageId, { reasoningEffort: value })),
							),
							react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
								react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("progressRequirementsTitle")),
								(row.requirements || []).map((requirement, reqIdx) => react.createElement("div", {
									key: "req-" + reqIdx,
									style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
								},
									requirement.kind === "file"
										? react.createElement("input", {
											style: { ...styles.input, flex: 1, minWidth: 160 },
											placeholder: t("reqFilePathPlaceholder"),
											value: requirement.path || "",
											onChange: (e) => updateRequirement(mode.stageId, reqIdx, { path: e.target.value }),
										})
										: react.createElement(react.Fragment, null,
											react.createElement("input", {
												style: { ...styles.input, flex: 1, minWidth: 140 },
												placeholder: t("reqSkillNamePlaceholder"),
												value: requirement.name || "",
												onChange: (e) => updateRequirement(mode.stageId, reqIdx, { name: e.target.value }),
											}),
											react.createElement("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
												react.createElement("input", {
													type: "checkbox",
													checked: Boolean(requirement.requireTrueField),
													onChange: (e) => updateRequirement(mode.stageId, reqIdx, { requireTrueField: e.target.checked }),
												}),
												t("reqTrueField"),
											),
											requirement.requireTrueField
												? react.createElement("input", {
													style: { ...styles.input, width: 110 },
													placeholder: t("reqTrueFieldPlaceholder"),
													value: requirement.trueField || "",
													onChange: (e) => updateRequirement(mode.stageId, reqIdx, { trueField: e.target.value }),
												})
												: null,
										),
									react.createElement("button", { style: styles.button, onClick: () => removeRequirement(mode.stageId, reqIdx) }, t("reqDelete")),
								)),
								react.createElement("select", {
									style: { ...styles.input, maxWidth: 220 },
									value: "",
									onChange: (e) => {
										const kind = e.target.value;
										if (kind) addRequirement(mode.stageId, kind);
									},
								},
									react.createElement("option", { value: "" }, t("reqAdd")),
									react.createElement("option", { value: "file" }, t("reqAddFile")),
									react.createElement("option", { value: "skill" }, t("reqAddSkill")),
								),
							),
							react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
								react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("restrictionRef")),
								react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
									react.createElement("select", {
										style: { ...styles.input, flex: 1 },
										value: row.restriction || "",
										onChange: (e) => updateDraft(mode.stageId, { restriction: e.target.value }),
									},
										react.createElement("option", { value: "" }, t("restrictionNone")),
										restrictionStore.sets.map((entry) => react.createElement("option", { key: entry.id, value: entry.id },
											(entry.label || entry.id) + " (" + entry.id + (entry.mode ? ", " + entry.mode : "") + ")")),
									),
									react.createElement("button", {
										style: styles.button,
										onClick: () => setRestrictionOpen((prev) => ({ ...prev, [mode.stageId]: !prev[mode.stageId] })),
									}, restrictionOpen[mode.stageId] ? t("restrictionHide") : t("restrictionView")),
								),
								restrictionOpen[mode.stageId] && row.restriction ? (() => {
									const hit = restrictionStore.sets.find((entry) => entry && entry.id === row.restriction);
									if (!hit) return react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, t("restrictionEmpty"));
									const parts = [];
									parts.push(hit.mode === "whitelist" ? t("restrictionWhitelist") : t("restrictionBlacklist"));
									if (hit.mode === "blacklist") {
										if (Array.isArray(hit.denyTools) && hit.denyTools.length) parts.push("禁工具: " + hit.denyTools.join(", "));
										if (Array.isArray(hit.denySkills) && hit.denySkills.length) parts.push("禁 skill: " + hit.denySkills.join(", "));
										if (Array.isArray(hit.denyCommands) && hit.denyCommands.length) parts.push("禁命令: " + hit.denyCommands.map((e) => (e.commands || []).join(",")).join(" | "));
									} else if (hit.mode === "whitelist") {
										parts.push("仅允许 skill: " + (((hit.allowSkills || []).join(", ")) || "（空=全禁）"));
									}
									return react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, whiteSpace: "pre-wrap" } }, parts.join("；"));
								})() : null,
							),
							react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
								react.createElement("button", { style: styles.button, onClick: () => saveStage(mode.stageId) }, t("saveWorkflow")),
								settings.savedAt ? react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, t("workflowSettingsSaveSuccess")) : null,
							),
						),
					);
				}),
				settingsError ? react.createElement("p", { style: styles.error }, settingsError) : null,
			);
		}


/** 模型压缩上下文设置页：动态全量表格，每行可填写自定义压缩点 */
function ModelCompressionView(props) {
const { t, api, getModelCatalog } = props;
const [builtin, setBuiltin] = react.useState([]);
const [overrides, setOverrides] = react.useState({});
const [groups, setGroups] = react.useState([]);
const [draft, setDraft] = react.useState({});
const [status, setStatus] = react.useState('');
const [loaded, setLoaded] = react.useState(false);

const reload = async () => {
let table = [];
let ov = {};
try {
const result = await api().getModelCompressionTable();
if (result && result.ok && result.value) {
table = Array.isArray(result.value.table) ? result.value.table : [];
if (result.value.overrides && typeof result.value.overrides === 'object') ov = result.value.overrides;
}
} catch (_err) {
setStatus('读取压缩配置失败');
}
try {
const ovResult = await api().getCompressionOverrides().catch(() => null);
if (ovResult && ovResult.ok && ovResult.value && ovResult.value.overrides) ov = ovResult.value.overrides;
} catch (_e2) {}
setBuiltin(table);
setOverrides(ov || {});
const nextDraft = {};
for (const key of Object.keys(ov || {})) nextDraft[key] = String(ov[key]);
setDraft(nextDraft);
try {
if (typeof getModelCatalog === 'function') {
const response = await getModelCatalog();
const value = response && response.value ? response.value : response;
if (value && Array.isArray(value.groups)) {
setGroups(value.groups.map((group) => ({
id: group.id,
models: Array.isArray(group.models) ? group.models.map((model) => ({ id: model.id, name: model.name })) : [],
})));
}
}
} catch (_e3) {}
setLoaded(true);
};

react.useEffect(() => { reload(); }, [api, getModelCatalog]);

const byId = {};
for (const entry of builtin) {
if (entry && entry.modelId) byId[entry.modelId] = entry;
}
const rows = [];
const seen = new Set();
for (const group of groups) {
for (const model of (group.models || [])) {
if (!model || !model.id || seen.has(model.id)) continue;
seen.add(model.id);
const base = byId[model.id] || null;
rows.push({
modelId: model.id,
provider: group.id,
contextWindow: base && Number.isFinite(base.contextWindow) ? base.contextWindow : null,
defaultPoint: base && Number.isFinite(base.defaultPoint) ? base.defaultPoint : 180000,
label: base ? base.label : '自带',
sourceUrl: base ? (base.sourceUrl || '') : '',
});
}
}
for (const entry of builtin) {
if (!entry || !entry.modelId || seen.has(entry.modelId)) continue;
seen.add(entry.modelId);
rows.push({
modelId: entry.modelId,
provider: entry.provider || '-',
contextWindow: Number.isFinite(entry.contextWindow) ? entry.contextWindow : null,
defaultPoint: Number.isFinite(entry.defaultPoint) ? entry.defaultPoint : 180000,
label: entry.label || '自带',
sourceUrl: entry.sourceUrl || '',
});
}

const formatNumber = (num) => {
if (!Number.isFinite(num)) return '-';
return num >= 1000 ? (num / 1000).toFixed(num % 1000 === 0 ? 0 : 1) + 'k' : String(num);
};

const getBadgeStyle = (tag) => {
switch (tag) {
case '证': return { background: '#52c41a', color: '#fff' };
case '自定义': return { background: '#faad14', color: '#fff' };
default: return { background: '#d9d9d9', color: '#333' };
}
};

const updateDraft = (modelId, value) => setDraft((prev) => ({ ...prev, [modelId]: value }));

const saveAll = async () => {
const next = {};
for (const entry of Object.entries(draft)) {
const key = entry[0];
const text = String(entry[1] == null ? '' : entry[1]).trim();
if (!text) continue;
const num = Number(text);
if (!Number.isFinite(num) || num <= 0) continue;
next[key] = Math.floor(num);
}
try {
const result = await api().setCompressionOverrides({ overrides: next });
if (result && result.ok && result.value) {
setOverrides(result.value.overrides || next);
setStatus('已保存，填写值立即参与压缩决策。');
} else {
setStatus('保存失败');
}
} catch (err) {
setStatus('保存失败：' + String((err && err.message) || err));
}
};

const body = !loaded
? react.createElement("p", { style: styles.desc }, "正在加载模型列表…")
: rows.length === 0
? react.createElement("p", { style: styles.error }, "暂无模型数据：内置表为空且未能获取 provider 模型列表。")
: react.createElement("table", { style: styles.table },
react.createElement("thead", null,
react.createElement("tr", null,
react.createElement("th", { style: styles.th }, "模型 ID"),
react.createElement("th", { style: styles.th }, "Provider"),
react.createElement("th", { style: styles.th }, "上下文窗口"),
react.createElement("th", { style: styles.th }, "压缩点（tokens，可填）"),
react.createElement("th", { style: styles.th }, "生效值"),
react.createElement("th", { style: styles.th }, "标签"),
react.createElement("th", { style: styles.th }, "资料链接"),
)
),
react.createElement("tbody", null,
rows.map((row) => {
const filled = String(draft[row.modelId] == null ? '' : draft[row.modelId]).trim();
const filledNum = Number(filled);
const hasFilled = filled !== '' && Number.isFinite(filledNum) && filledNum > 0;
const effective = hasFilled ? Math.floor(filledNum) : row.defaultPoint;
const tag = hasFilled ? '自定义' : (row.label === '证' ? '证' : '自带');
return react.createElement("tr", { key: row.modelId },
react.createElement("td", { style: styles.td },
react.createElement("code", { style: styles.code }, row.modelId)),
react.createElement("td", { style: styles.td }, row.provider || '-'),
react.createElement("td", { style: styles.td }, formatNumber(row.contextWindow)),
react.createElement("td", { style: styles.td },
react.createElement("input", { style: { ...styles.input, minWidth: 110 }, placeholder: String(row.defaultPoint), value: draft[row.modelId] == null ? '' : draft[row.modelId], onChange: (e) => updateDraft(row.modelId, e.target.value) })),
react.createElement("td", { style: styles.td }, formatNumber(effective)),
react.createElement("td", { style: styles.td },
react.createElement("span", {
style: {
display: 'inline-block',
padding: '2px 8px',
borderRadius: '4px',
fontSize: '12px',
...getBadgeStyle(tag)
}
}, tag)),
react.createElement("td", { style: styles.td },
row.sourceUrl ? react.createElement("a", {
href: row.sourceUrl,
target: "_blank",
rel: "noopener noreferrer",
style: { color: "var(--dsw-alias-label-primary)", fontSize: 12 }
}, "查看资料") : '-'));
})
)
);

return react.createElement("div", { style: styles.section },
react.createElement("h3", { style: styles.denyHead }, "模型压缩上下文"),
react.createElement("p", { style: styles.desc }, "压缩规则：上下文窗口 <150k 的模型在约 80% 处压缩；其余模型默认在 180k 处压缩；已查证模型使用查证值。下表列出全部模型，可为任意模型填写自定义压缩点（tokens）：填了就按填写值压缩，清空则恢复自带默认，保存后立即生效。"),
body,
react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 8 } },
react.createElement("button", { style: styles.button, onClick: saveAll }, "保存压缩点"),
status ? react.createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, status) : null),
);
}

		/** 「模型代号映射」tab：代号 → 具体模型的映射表（与「当前配置」平级）。 */
		function ModelAliasesTab(props) {
			const { t, api, getModelCatalog } = props;
			const modelAliases = useModelAliases(api);
			const providerModels = useProviderModels(getModelCatalog);

			const [aliasDraft, setAliasDraft] = react.useState([]);
			const [newAlias, setNewAlias] = react.useState({ alias: "", provider: "", model: "", thinking: "" });

			react.useEffect(() => {
				setAliasDraft((modelAliases.entries || []).map((entry) => ({ ...entry })));
			}, [modelAliases.entries]);

			// model aliases (codename -> concrete model)
			const updateAlias = (idx, key, value) => setAliasDraft((prev) => prev.map((entry, i) => (
				i === idx ? { ...entry, [key]: value } : entry
			)));
			const addAlias = async () => {
				if (!newAlias.alias.trim() || !newAlias.model.trim()) return;
				const next = [...aliasDraft, { alias: newAlias.alias.trim(), provider: newAlias.provider.trim(), model: newAlias.model.trim(), thinking: (newAlias.thinking || "").trim() }];
				setAliasDraft(next);
				setNewAlias({ alias: "", provider: "", model: "", thinking: "" });
				await modelAliases.save(next);
			};
			const deleteAlias = async (idx) => {
				const next = aliasDraft.filter((_, i) => i !== idx);
				setAliasDraft(next);
				await modelAliases.save(next);
			};
			const saveAliases = async () => { await modelAliases.save(aliasDraft); };

			// model aliases (codename -> concrete model) UI
			const providerOptions = providerModels.groups || [];
			const aliasTargetSelect = (entry, idx, isNew) => {
				const currentProvider = entry.provider || (providerOptions[0] ? providerOptions[0].id : "");
				const group = providerOptions.find((g) => g.id === currentProvider);
				const models = group ? group.models : [];
				const providerSel = react.createElement("select", {
					style: { ...styles.input, maxWidth: 200 },
					value: currentProvider,
					onChange: (e) => {
						const nextProvider = e.target.value;
						const nextGroup = providerOptions.find((g) => g.id === nextProvider);
						const firstModel = nextGroup && nextGroup.models[0] ? nextGroup.models[0].id : "";
						if (isNew) {
							setNewAlias((prev) => ({ ...prev, provider: nextProvider, model: firstModel, thinking: "" }));
						} else {
							updateAlias(idx, "provider", nextProvider);
							updateAlias(idx, "model", firstModel);
						updateAlias(idx, "thinking", "");
						}
					},
				}, providerOptions.map((g) => react.createElement("option", { key: g.id, value: g.id }, g.id)));
				const modelSel = react.createElement("select", {
					style: { ...styles.input, maxWidth: 240 },
					value: entry.model || "",
					onChange: (e) => {
						if (isNew) setNewAlias((prev) => ({ ...prev, model: e.target.value, thinking: "" }));
						else { updateAlias(idx, "model", e.target.value); updateAlias(idx, "thinking", ""); }
					},
				}, models.map((m) => react.createElement("option", { key: m.id, value: m.id }, m.name || m.id)));
				return react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
					providerSel, react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, "/"), modelSel);
			};
			const aliasHead = react.createElement("h3", { style: styles.denyHead }, t("modelAliasesTitle"));
			const aliasDesc = react.createElement("p", { style: styles.desc }, t("modelAliasesDesc"));
			// 思考等级下拉：与选模型同款原生 select。选项优先用该模型 provider 真实数据
			// （modelCatalog reasoning.efforts），无数据时回落五个固定档位；空值表示跟随默认。
			const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];
			const thinkingOptionsOf = (entry) => {
				const currentProvider = entry.provider || (providerOptions[0] ? providerOptions[0].id : "");
				const group = providerOptions.find((g) => g.id === currentProvider);
				const model = group && Array.isArray(group.models) ? group.models.find((m) => m.id === entry.model) : null;
				const reasoning = model && model.reasoning ? model.reasoning : null;
				const live = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts.map((e) => e && e.id).filter(Boolean) : [];
				const seen = new Set();
				const out = [];
				for (const id of [...live, ...THINKING_LEVELS]) {
					const key = String(id).toLowerCase();
					if (!key || seen.has(key)) continue;
					seen.add(key);
					out.push(String(id));
				}
				return { options: out, defaultEffort: reasoning && reasoning.defaultEffort ? String(reasoning.defaultEffort) : "" };
			};
			const thinkingSelect = (entry, idx, isNew) => {
				const { options, defaultEffort } = thinkingOptionsOf(entry);
				const value = entry.thinking || "";
				return react.createElement("select", {
					style: { ...styles.input, maxWidth: 160 },
					value,
					onChange: (e) => {
						if (isNew) setNewAlias((prev) => ({ ...prev, thinking: e.target.value }));
						else updateAlias(idx, "thinking", e.target.value);
					},
				}, [
					react.createElement("option", { key: "", value: "" }, defaultEffort ? `默认（${defaultEffort}）` : "默认"),
					...options.map((id) => react.createElement("option", { key: id, value: id }, id)),
				]);
			};
			const aliasRows = aliasDraft.map((entry, idx) => react.createElement("tr", { key: entry.alias || idx },
				react.createElement("td", { style: styles.td },
					react.createElement("input", { style: styles.input, value: entry.alias || '', onChange: (e) => updateAlias(idx, 'alias', e.target.value) })),
				react.createElement("td", { style: styles.td }, aliasTargetSelect(entry, idx, false)),
				react.createElement("td", { style: styles.td }, thinkingSelect(entry, idx, false)),
				react.createElement("td", { style: styles.td },
					react.createElement("button", { style: styles.button, onClick: () => deleteAlias(idx) }, t("delete"))),
			));
			const aliasTable = react.createElement("table", { style: styles.table },
				react.createElement("thead", null,
					react.createElement("tr", null,
						react.createElement("th", { style: styles.th }, t("modelAliasColumn")),
						react.createElement("th", { style: styles.th }, t("modelAliasTargetColumn")),
						react.createElement("th", { style: styles.th }, t("modelThinkingAliasColumn")),
						react.createElement("th", { style: styles.th }, ""),
					)
				),
				react.createElement("tbody", null, aliasRows),
			);
			const aliasAddRow = react.createElement("div", { style: styles.addRow },
				react.createElement("input", { style: styles.input, placeholder: t("modelAliasPlaceholder"), value: newAlias.alias, onChange: (e) => setNewAlias((prev) => ({ ...prev, alias: e.target.value })) }),
				aliasTargetSelect(newAlias, -1, true),
				thinkingSelect(newAlias, -1, true),
				react.createElement("button", { style: styles.button, onClick: addAlias }, t("addModelAlias")),
			);
			const aliasSaveButton = react.createElement("button", { style: styles.button, onClick: saveAliases }, t("saveModelAliases"));
			const aliasErrorLine = modelAliases.error ? react.createElement("p", { style: styles.error }, typeof modelAliases.error === "string" ? modelAliases.error : t("loadModelCatalogFailed")) : null;
			const aliasProviderErrorLine = providerModels.error ? react.createElement("p", { style: styles.error }, t("loadProviderModelsFailed")) : null;

			return react.createElement("div", { style: styles.section },
				aliasHead, aliasDesc, aliasTable, aliasAddRow, aliasSaveButton, aliasErrorLine, aliasProviderErrorLine,
			);
		}
		/** 「限制」tab：全部限制套件的可展开列表，可新建/编辑/删除。 */
		function useRestrictions(api) {
			const [sets, setSets] = react.useState([]);
			const [error, setError] = react.useState("");
			const refresh = react.useCallback(async () => {
				try {
					const result = await api().getRestrictions();
					if (result && result.ok && result.value && Array.isArray(result.value.sets)) {
						setSets(result.value.sets);
						setError("");
					} else if (result && result.ok === false) {
						setError(typeof result.error === "string" ? result.error : "loadFailed");
					} else {
						setSets([]);
					}
				} catch (err) {
					setError(String((err && err.message) || err));
				}
			}, [api]);
			react.useEffect(() => { refresh(); }, [refresh]);
			const saveSet = react.useCallback(async (set) => {
				try {
					const result = await api().setRestriction({ set });
					if (result && result.ok && result.value) {
						setError("");
						await refresh();
						return { ok: true };
					}
					const msg = result && typeof result.error === "string" ? result.error : "saveFailed";
					setError(msg);
					return { ok: false, error: msg };
				} catch (err) {
					const msg = String((err && err.message) || err);
					setError(msg);
					return { ok: false, error: msg };
				}
			}, [api, refresh]);
			const deleteSet = react.useCallback(async (id) => {
				try {
					const result = await api().deleteRestriction({ id });
					if (result && result.ok !== false) {
						setError("");
						await refresh();
						return { ok: true };
					}
					const msg = result && typeof result.error === "string" ? result.error : "saveFailed";
					setError(msg);
					return { ok: false, error: msg };
				} catch (err) {
					const msg = String((err && err.message) || err);
					setError(msg);
					return { ok: false, error: msg };
				}
			}, [api, refresh]);
			return { sets, error, refresh, saveSet, deleteSet };
		}

		function RestrictionsTab(props) {
			const { t, api } = props;
			const store = useRestrictions(api);
			const [expanded, setExpanded] = react.useState({});
			const [drafts, setDrafts] = react.useState({});
			const [newId, setNewId] = react.useState("");
			const [newLabel, setNewLabel] = react.useState("");
			const [newMode, setNewMode] = react.useState("blacklist");
			const updateDraft = (id, key, value) => setDrafts((prev) => ({ ...prev, [id]: { ...getDraftById(id), [key]: value } }));
			const getDraftById = (id) => {
				if (drafts[id]) return drafts[id];
				const set = store.sets.find((e) => e.id === id);
				if (!set) return { label: id, mode: "blacklist", denyCommands: "", denyReason: "", denySkills: "", allowSkills: "" };
				return {
					label: set.label || set.id,
					mode: set.mode || "blacklist",
					denyCommands: (set.denyCommands || []).map((e) => (e.commands || []).join(", ")).join(" | "),
					denyReason: (set.denyCommands && set.denyCommands[0] && set.denyCommands[0].reason) || "",
					denySkills: (set.denySkills || []).join(", "),
					allowSkills: (set.allowSkills || []).join(", "),
				};
			};
			const splitList = (text) => String(text || "").split(/[\s,]+/).filter(Boolean);
			const saveDraft = async (set) => {
				const d = getDraftById(set.id);
				const denyGroups = splitList(d.denyCommands).length
					? [{ id: `deny-${Date.now()}`, commands: splitList(d.denyCommands), reason: String(d.denyReason || "").trim() }]
					: [];
					await store.saveSet({
					id: set.id,
					label: String(d.label || "").trim() || set.id,
					mode: d.mode,
					denyCommands: denyGroups,
					denySkills: splitList(d.denySkills),
					allowSkills: splitList(d.allowSkills),
				});
			};
			const addSet = async () => {
				if (!newId.trim()) return;
				const result = await store.saveSet({ id: newId.trim(), label: newLabel.trim() || newId.trim(), mode: newMode, denyCommands: [], denySkills: [], allowSkills: [] });
				if (result && result.ok) {
					setNewId("");
					setNewLabel("");
					setExpanded((prev) => ({ ...prev, [newId.trim()]: true }));
				}
			};
			const modeBadge = (mode) => react.createElement("span", {
				style: { whiteSpace: "nowrap", background: mode === "whitelist" ? "var(--dsw-alias-bg-module-platform)" : "var(--dsw-alias-border-l2)", borderRadius: 999, padding: "1px 8px", fontSize: 11, lineHeight: "17px" },
			}, mode === "whitelist" ? t("restrictionWhitelist") : t("restrictionBlacklist"));
			return react.createElement("div", { style: styles.section },
				react.createElement("h3", { style: styles.denyHead }, t("tabRestrictions")),
				react.createElement("p", { style: styles.desc }, t("restrictionDesc")),
				store.sets.map((set) => {
					const isOpen = Boolean(expanded[set.id]);
					const d = getDraftById(set.id);
					return react.createElement("div", {
						key: set.id,
						style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, overflow: "hidden" },
					},
						react.createElement("button", {
							type: "button",
							onClick: () => setExpanded((prev) => ({ ...prev, [set.id]: !prev[set.id] })),
							style: { ...styles.button, width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 8, border: "none", borderRadius: 0, padding: "10px 12px" },
						},
							react.createElement("span", { style: { fontSize: 12, lineHeight: "18px" } }, isOpen ? "▾" : "▸"),
							react.createElement("code", { style: styles.code }, set.id),
							react.createElement("span", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 13, flex: 1 } }, set.label || set.id),
							modeBadge(set.mode),
						),
						isOpen && react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px" } },
							react.createElement("input", { style: styles.input, value: d.label, onChange: (e) => updateDraft(set.id, "label", e.target.value) }),
							react.createElement("select", { style: styles.input, value: d.mode, onChange: (e) => updateDraft(set.id, "mode", e.target.value) },
								react.createElement("option", { value: "blacklist" }, t("restrictionBlacklist")),
								react.createElement("option", { value: "whitelist" }, t("restrictionWhitelist")),
							),
							d.mode === "blacklist" ? react.createElement("input", { style: styles.input, placeholder: t("restrictionDenyCommands"), value: d.denyCommands, onChange: (e) => updateDraft(set.id, "denyCommands", e.target.value) }) : null,
						d.mode === "blacklist" ? react.createElement("input", { style: styles.input, placeholder: t("denyReason"), value: d.denyReason, onChange: (e) => updateDraft(set.id, "denyReason", e.target.value) }) : null,
							d.mode === "blacklist" ? react.createElement("input", { style: styles.input, placeholder: t("restrictionDenySkills"), value: d.denySkills, onChange: (e) => updateDraft(set.id, "denySkills", e.target.value) }) : null,
							d.mode === "whitelist" ? react.createElement("input", { style: styles.input, placeholder: t("restrictionAllowSkills"), value: d.allowSkills, onChange: (e) => updateDraft(set.id, "allowSkills", e.target.value) }) : null,
							react.createElement("div", { style: { display: "flex", gap: 8 } },
								react.createElement("button", { style: styles.button, onClick: () => saveDraft(set) }, t("save")),
								react.createElement("button", { style: styles.button, onClick: () => store.deleteSet(set.id) }, t("delete")),
							),
						),
					);
				}),
				react.createElement("div", { style: styles.addRow },
					react.createElement("input", { style: styles.input, placeholder: t("restrictionNewId"), value: newId, onChange: (e) => setNewId(e.target.value) }),
					react.createElement("input", { style: styles.input, placeholder: t("restrictionNewLabel"), value: newLabel, onChange: (e) => setNewLabel(e.target.value) }),
					react.createElement("select", { style: styles.input, value: newMode, onChange: (e) => setNewMode(e.target.value) },
						react.createElement("option", { value: "blacklist" }, t("restrictionBlacklist")),
						react.createElement("option", { value: "whitelist" }, t("restrictionWhitelist")),
					),
					react.createElement("button", { style: styles.button, onClick: addSet }, t("add")),
				),
				store.error ? react.createElement("p", { style: styles.error }, store.error) : null,
			);
		}

		/** 独立的「设置 → 模式门禁」页面：顶部「当前配置 / 所有模式 / 模型代号映射 / 模型压缩上下文 / 限制」五个 tab。 */
		function ModeGateSettingsSection(props) {
			const { t, api, getModelCatalog } = props;
			const [activeTab, setActiveTab] = react.useState("current");
			const [focusStageId, setFocusStageId] = react.useState("");
			const openStage = (stageId) => {
				if (typeof stageId === "string" && stageId) setFocusStageId(stageId);
				setActiveTab("all");
			};
			const tabButton = (id, label) => react.createElement("button", {
				key: id,
				type: "button",
				onClick: () => setActiveTab(id),
				style: {
					padding: "6px 10px",
					border: "none",
					borderBottom: `2px solid ${activeTab === id ? "var(--dsw-alias-label-primary)" : "transparent"}`,
					background: "transparent",
					color: activeTab === id ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
					fontSize: 13,
					cursor: "pointer",
					fontWeight: activeTab === id ? 600 : 400,
				},
			}, label);
			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12, width: "100%" } },
				react.createElement("div", { style: { display: "flex", gap: 4, borderBottom: "1px solid var(--dsw-alias-border-l2)" } },
					tabButton("current", t("tabCurrent")),
					tabButton("all", t("tabAllModes")),
					tabButton("aliases", t("tabAliases")),
					tabButton("compression", t("tabCompression")),
					tabButton("restrictions", t("tabRestrictions")),
				),
				activeTab === "current"
					? react.createElement(ModeGateSettingsTab, { t, api, onOpenStage: openStage })
					: activeTab === "all"
						? react.createElement(ModeGateAllModesTab, { t, api, focusStageId })
						: activeTab === "aliases"
							? react.createElement(ModelAliasesTab, { t, api, getModelCatalog })
							: activeTab === "restrictions"
							? react.createElement(RestrictionsTab, { t, api })
							: react.createElement(ModelCompressionView, { t, api, getModelCatalog }),
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
				remoteArgsDescriptor("getFeatureTree", "GetFeatureTreeResult"),
				remoteArgsDescriptor("getFeatureNode", "GetFeatureNodeResult"),
				remoteArgsDescriptor("createFeatureNode", "CreateFeatureNodeResult"),
				remoteArgsDescriptor("submitFeatureSelection", "SubmitFeatureSelectionResult"),
				remoteDescriptor("getBashDenyList", "GetBashDenyListResult"),
				remoteArgsDescriptor("setBashDenyList", "SetBashDenyListResult"),
				remoteDescriptor("getModelCatalog", "GetModelCatalogResult"),
				remoteArgsDescriptor("setModelCatalog", "SetModelCatalogResult"),
				remoteDescriptor("getModelAliases", "GetModelAliasesResult"),
				remoteArgsDescriptor("setModelAliases", "SetModelAliasesResult"),
				remoteDescriptor("getModelCompressionTable", "GetModelCompressionTableResult"),
				remoteDescriptor("getCompressionOverrides", "GetCompressionOverridesResult"),
				remoteArgsDescriptor("setCompressionOverrides", "SetCompressionOverridesResult"),
				remoteDescriptor("getRestrictions", "GetRestrictionsResult"),
				remoteArgsDescriptor("getRestriction", "GetRestrictionResult"),
				remoteArgsDescriptor("setRestriction", "SetRestrictionResult"),
				remoteArgsDescriptor("deleteRestriction", "DeleteRestrictionResult"),
				remoteDescriptor("getWorkflowSettings", "GetWorkflowSettingsResult"),
				remoteArgsDescriptor("setWorkflowOverride", "SetWorkflowOverrideResult"),
				remoteArgsDescriptor("setStageOverride", "SetStageOverrideResult"),
				remoteArgsDescriptor("approveRequirementProtocol", "ApproveRequirementProtocolResult"),
				remoteArgsDescriptor("rejectRequirementProtocol", "RejectRequirementProtocolResult"),
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

		/** Fetch the feature overview/intent tree for the picker. */
		function useFeatureTree(api, enabled, sessionId) {
			const [data, setData] = react.useState({ tree: [], dir: "", error: "", mode: "flat", workspace: "", roots: [] });
			const [nonce, setNonce] = react.useState(0);
			react.useEffect(() => {
				if (!enabled) return undefined;
				let current = true;
				const refresh = async () => {
					try {
						const result = await api().getFeatureTree({ sessionId });
						if (!current) return;
						/* Typert 回的是 {ok, value} 信封：host 的返回值包在 value 里，
						   直接读 result.tree 会永远是 undefined（这就是之前空树的根因）。 */
						const payload = result && result.ok ? (result.value || {}) : null;
						try {
							if (typeof console !== "undefined" && console.log) {
								console.log("[mg-client][feature-tree] getFeatureTree 返回：", JSON.stringify({
									session: typeof sessionId === "string" ? sessionId : ("(非字符串:" + typeof sessionId + ")"),
									ok: Boolean(result && result.ok),
									hostOk: payload ? payload.ok : null,
									mode: payload && payload.mode,
									tree: payload && Array.isArray(payload.tree) ? payload.tree.length : null,
									dir: payload && payload.dir,
									workspace: payload && payload.workspace,
									roots: payload && payload.roots,
									error: (payload && payload.error) || (result && result.error),
								}));
							}
						} catch (_logErr) { /* 日志失败不影响取树 */ }
						if (payload && payload.ok !== false) {
							setData({
								tree: payload.tree || [],
								dir: payload.dir || "",
								error: "",
								mode: payload.mode === "mounts" ? "mounts" : "flat",
								workspace: payload.workspace || "",
								roots: Array.isArray(payload.roots) ? payload.roots : [],
							});
						} else {
							setData({ tree: [], dir: "", error: String((payload && payload.error) || (result && result.error) || "读取 feature 树失败"), mode: "flat", workspace: "", roots: [] });
						}
					} catch (err) {
						if (current) setData({ tree: [], dir: "", error: String((err && err.message) || err), mode: "flat", workspace: "", roots: [] });
					}
				};
				refresh();
				const timer = setInterval(refresh, 5000);
				return () => { current = false; clearInterval(timer); };
			}, [api, enabled, sessionId, nonce]);
			return { ...data, refresh: () => setNonce((n) => n + 1) };
		}

		/**
		 * Feature overview / intent 树状选择器。
		 *
		 * - 文件夹（overview）右侧的箭头按钮负责展开/收起，点主体即选中；
		 * - 叶子（intent）点主体即选中；
		 * - overview 与 intent 均可多选；
		 * - 底部「提交」按钮把选中的节点集合交回上层。
		 */
		function FeatureTreePicker(props) {
			const { api, busy, onSubmit, onError, selected, onSelectedChange, t, sessionId } = props;
			const { tree, error, refresh, mode, roots, dir } = useFeatureTree(api, true, sessionId);
			const [expanded, setExpanded] = react.useState({});
			/* 多项目 workspace：顶层项目文件夹默认展开，否则用户会以为「树是空的」。 */
			const autoExpanded = react.useRef(false);
			react.useEffect(() => {
				if (autoExpanded.current || tree.length === 0) return;
				const init = {};
				for (const node of tree) {
					if (node && node.type === "overview" && node.mounted) init[node.path] = true;
				}
				if (Object.keys(init).length > 0) {
					autoExpanded.current = true;
					setExpanded((prev) => ({ ...init, ...prev }));
				}
			}, [tree]);

			/* 就地新建：类型 + 父 overview + 名称。 */
			const [createOpen, setCreateOpen] = react.useState(false);
			const [newKind, setNewKind] = react.useState("intent");
			const [newParent, setNewParent] = react.useState("");
			const [newName, setNewName] = react.useState("");
			const [createBusy, setCreateBusy] = react.useState(false);
			const [createMsg, setCreateMsg] = react.useState("");

			const multiRoot = mode === "mounts";

			/* 可选父 overview 列表（含根层级 ""）。多项目 workspace 下顶层是各项目目录。 */
			const parentOptions = react.useMemo(() => {
				const out = multiRoot
					? []
					: [{ path: "", label: "（根层级）" }];
				const walk = (list, depth) => {
					for (const node of list || []) {
						if (node.type !== "overview") continue;
						out.push({ path: node.path, label: `${"　".repeat(depth)}${node.mounted ? "［项目］" : ""}${node.name}` });
						if (node.children) walk(node.children, depth + 1);
					}
				};
				walk(tree, 0);
				return out;
			}, [tree, multiRoot]);

			/* 互斥：同一组选择里只能是 overview 或 intent 之一（同类可多选）。 */
			const selectedType = (selected && selected.length > 0) ? selected[0].type : null;
			const isBlockedByType = (node) => Boolean(selectedType) && node.type !== selectedType;

			const toggleExpand = (path) => {
				setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));
			};

			const toggleSelect = (node) => {
				if (isBlockedByType(node)) {
					onError("overview 与底层 feature intent 不能同时选择：请先取消当前选择。");
					return;
				}
				onError("");
				onSelectedChange((prev) => {
					const key = `${node.type}:${node.path}`;
					const exists = prev.some((item) => `${item.type}:${item.path}` === key);
					if (exists) return prev.filter((item) => `${item.type}:${item.path}` !== key);
					return [...prev, { type: node.type, path: node.path, name: node.name }];
				});
			};

			const isSelected = (node) => (selected || []).some((item) => item.type === node.type && item.path === node.path);

			const submitCreate = async () => {
				if (createBusy) return;
				const name = newName.trim();
				if (!name) {
					setCreateMsg("请填写名称");
					return;
				}
				setCreateBusy(true);
				setCreateMsg("");
				try {
					const result = await api().createFeatureNode({
						sessionId, kind: newKind, parent: newParent, name,
					});
					const created = result && result.ok ? (result.value || {}) : null;
					if (!result || result.ok === false || (created && created.ok === false)) {
						setCreateMsg(String((created && created.error) || (result && result.error) || "创建失败"));
					} else {
						setCreateMsg(`已创建 ${newKind === "overview" ? "feature overview" : "feature intent"}：${name}`);
						setNewName("");
						if (newKind === "overview") setNewParent("");
						refresh();
					}
				} catch (err) {
					setCreateMsg(String((err && err.message) || err));
				} finally {
					setCreateBusy(false);
				}
			};

			const renderNode = (node, depth) => {
				const rows = [];
				const isOverview = node.type === "overview";
				const open = Boolean(expanded[node.path]);
				const sel = isSelected(node);
				const blocked = isBlockedByType(node);
				rows.push(react.createElement("div", {
					key: `${node.type}:${node.path}`,
					style: {
						display: "flex", alignItems: "center", gap: 6,
						padding: "4px 6px", paddingLeft: 6 + depth * 18,
						borderRadius: 6,
						background: sel ? "var(--dsw-alias-bg-selection, rgba(64,128,255,0.16))" : "transparent",
						opacity: blocked ? 0.4 : 1,
					},
				},
					isOverview
						? react.createElement("button", {
							type: "button",
							title: open ? "收起" : "展开",
							onClick: (event) => { event.stopPropagation(); toggleExpand(node.path); },
							style: {
								border: "none", background: "transparent", cursor: "pointer",
								color: "var(--dsw-alias-label-secondary)", fontSize: 12, width: 18,
								padding: 0, lineHeight: "18px",
							},
						}, open ? "▾" : "▸")
						: react.createElement("span", { style: { width: 18, display: "inline-block" } }),
					react.createElement("button", {
						type: "button",
						onClick: () => toggleSelect(node),
						title: blocked
							? "overview 与 feature intent 不能同时选择"
							: (node.title || node.name),
						style: {
							flex: 1, textAlign: "left", border: "none", background: "transparent",
							cursor: blocked ? "not-allowed" : "pointer", padding: "2px 0",
							color: "var(--dsw-alias-label-primary)", fontSize: 13,
							fontWeight: isOverview ? 600 : 400,
						},
					},
						`${isOverview ? "📁" : "📄"} ${node.name}${isOverview && node.children && node.children.length > 0 ? `（${node.children.length}）` : ""}`,
						node.mounted
							? react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, marginLeft: 8 } }, "项目目录")
							: null,
						node.title && node.title !== node.name
							? react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginLeft: 8 } }, node.title)
							: null
					),
					sel
						? react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 11 } }, "已选")
						: null
				));
				if (isOverview && open) {
					const children = node.children || [];
					if (children.length === 0) {
						rows.push(react.createElement("div", {
							key: `${node.type}:${node.path}:empty`,
							style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, paddingLeft: 24 + depth * 18 },
						}, "（空）"));
					} else {
						for (const child of children) rows.push(renderNode(child, depth + 1));
					}
				}
				return rows;
			};

			const nodes = [];
			if (tree.length === 0) {
				nodes.push(react.createElement("div", {
					key: "empty",
					style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, padding: "8px 0" },
				}, error
					? "（读取 feature 树失败，所以这里没有任何内容——请看上面的错误提示）"
					: "（尚未有任何 feature overview / feature intent）"));
			} else {
				for (const node of tree) nodes.push(renderNode(node, 0));
			}

			const count = (selected || []).length;

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, width: "100%" } },
				multiRoot
					? react.createElement("div", {
						style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "18px" },
					},
						`当前 workspace 下发现 ${roots.length} 个 feature intent 目录（顶层即各项目目录，overview 就是文件夹）。`,
						react.createElement("br"),
						"展开要改的项目 → 选中其中的 feature overview 或 feature intent；提交后本轮就锁定该项目目录。")
					: null,
				error
					? react.createElement("div", { style: { color: "var(--dsw-alias-label-error, #d33)", fontSize: 12 } }, error)
					: null,
				// 解析出来的项目目录 / 模式 / 节点数：树是空的时候，这行能直接说明
				// Host 到底把树解析到了哪里（空列表 + 目录正确 = 该目录里确实没有文件）。
				react.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 11, wordBreak: "break-all" } },
					`目录：${dir || "（未知）"}　模式：${multiRoot ? "多项目 workspace" : "单项目"}　节点：${tree.length}${roots.length > 0 ? `　发现 ${roots.length} 个项目目录` : ""}${typeof sessionId === "string" ? "" : "　会话：取不到当前会话 id（这是空树的头号嫌疑）"}`),
				react.createElement("div", {
					style: {
						maxHeight: 360, overflowY: "auto", border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.3))",
						borderRadius: 8, padding: "8px 6px", background: "var(--dsw-alias-bg-primary, transparent)",
					},
				}, ...nodes),
				react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
					react.createElement("button", {
						type: "button",
						onClick: () => { setCreateOpen((v) => !v); setCreateMsg(""); },
						style: {
							padding: "5px 10px", borderRadius: 8, fontSize: 12, cursor: "pointer",
							border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.3))",
							background: "transparent", color: "var(--dsw-alias-label-secondary)",
						},
					}, createOpen ? "▾ 收起新建" : "＋ 新建 overview / feature intent")
				),
				createOpen
					? react.createElement("div", {
						style: {
							display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px",
							border: "1px dashed var(--dsw-alias-border-secondary, rgba(128,128,128,0.35))",
							borderRadius: 8,
						},
					},
						react.createElement("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
							react.createElement("label", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", display: "flex", gap: 4, alignItems: "center" } },
								react.createElement("input", {
									type: "radio", name: "mg-new-kind", checked: newKind === "intent",
									onChange: () => setNewKind("intent"),
								}), "feature intent（文件）"
							),
							react.createElement("label", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", display: "flex", gap: 4, alignItems: "center" } },
								react.createElement("input", {
									type: "radio", name: "mg-new-kind", checked: newKind === "overview",
									onChange: () => setNewKind("overview"),
								}), "feature overview（文件夹）"
							)
						),
						react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
							react.createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, "父 overview"),
							react.createElement("select", {
								value: newParent,
								onChange: (event) => setNewParent(event.target.value),
								disabled: createBusy,
								style: {
									fontSize: 12, padding: "4px 6px", borderRadius: 6,
									border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.3))",
									background: "var(--dsw-alias-bg-primary, transparent)", color: "var(--dsw-alias-label-primary)",
								},
							}, ...parentOptions.map((opt) => react.createElement("option", { key: opt.path || "__root__", value: opt.path }, opt.label)))
						),
						react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
							react.createElement("input", {
								type: "text",
								value: newName,
								placeholder: "名称（字母/数字/_ . -）",
								onChange: (event) => setNewName(event.target.value),
								onKeyDown: (event) => { if (event.key === "Enter") submitCreate(); },
								disabled: createBusy,
								style: {
									flex: 1, fontSize: 12, padding: "5px 8px", borderRadius: 6,
									border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.3))",
									background: "var(--dsw-alias-bg-primary, transparent)", color: "var(--dsw-alias-label-primary)",
								},
							}),
							react.createElement("button", {
								type: "button",
								disabled: createBusy,
								onClick: submitCreate,
								style: {
									padding: "5px 12px", borderRadius: 8, border: "none", fontSize: 12, fontWeight: 600,
									cursor: createBusy ? "not-allowed" : "pointer",
									background: createBusy ? "var(--dsw-alias-bg-tertiary, #8884)" : "var(--dsw-alias-accent, #4080ff)",
									color: "#fff",
								},
							}, "创建")
						),
						createMsg
							? react.createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, createMsg)
							: null
					)
					: null,
				react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
					react.createElement("button", {
						type: "button",
						disabled: Boolean(busy) || count === 0,
						onClick: () => onSubmit(selected),
						style: {
							padding: "7px 16px", borderRadius: 8, border: "none",
							cursor: (busy || count === 0) ? "not-allowed" : "pointer",
							background: (busy || count === 0) ? "var(--dsw-alias-bg-tertiary, #8884)" : "var(--dsw-alias-accent, #4080ff)",
							color: "#fff", fontSize: 13, fontWeight: 600,
						},
					}, "提交"),
					react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } },
						count === 0 ? "请选择至少一个 feature overview 或 feature intent" : `已选 ${count} 项`)
				)
			);
		}

		/** Simple renderer for a pending feature-intent protocol. */
		function FeatureIntentApprovalView(props) {
			const { t, api, sessionId } = props;
			const state = useModeGateState(props.sessions, api);
			const pending = state.pendingProtocol;
			const display = pending && pending.display ? pending.display : null;
			const [busy, setBusy] = react.useState(false);
			const [approved, setApproved] = react.useState(false);
			const [error, setError] = react.useState("");

			const approve = async () => {
				if (busy || approved) return;
				setBusy(true);
				setError("");
				try {
					const result = await api().approveRequirementProtocol({ sessionId });
					if (result && result.ok === false) {
						setError(String(result.error || t("approveFailed")));
					} else {
						setApproved(true);
						// Let the header controller switch back to 对话 once the state
						// poll observes the transition; this delayed click only covers
						// layouts where the header controls are not mounted.
						setTimeout(() => activateChatView(), 2500);
					}
				} catch (err) {
					setError(String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			};

			const field = (label, value) => react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
				react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, label),
				react.createElement("span", { style: { whiteSpace: "pre-wrap", color: "var(--dsw-alias-label-primary)", fontSize: 13 } }, String(value || "（空）")),
			);

			return react.createElement("div", {
				style: {
					height: "100%", width: "100%", overflowY: "auto",
					padding: "28px 32px", display: "flex", flexDirection: "column",
					alignItems: "center", gap: 12,
				},
			},
				react.createElement("div", { style: { width: "100%", maxWidth: 720, display: "flex", flexDirection: "column", gap: 14 } },
					react.createElement("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 20, fontWeight: 600 } }, t("pendingProtocolTitle")),
					react.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: "20px" } }, t("pendingProtocolDesc")),
					field(t("fieldFeatureIntentFile"), display && display.featureIntentFile),
					field(t("fieldSummary"), display && display.summary),
					field(t("fieldUserWords"), display && display.userWords),
					field(t("fieldUnderstanding"), display && display.understanding),
					field(t("fieldUserVisibleBehavior"), display && display.userVisibleBehavior),
					field(t("fieldFeatureIntent"), display && display.featureIntent),
					react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
						react.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 } }, t("fieldChecklist")),
						react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
							(Array.isArray(display && display.checklist) ? display.checklist : []).map((item, idx) => react.createElement("div", { key: idx, style: { display: "flex", gap: 8 } },
								react.createElement("code", { style: styles.code }, `checklist-${idx + 1}`),
								react.createElement("span", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 13 } }, item),
							)),
						),
					),
					react.createElement("button", { style: { ...styles.button, alignSelf: "flex-start", padding: "8px 18px" }, onClick: approve, disabled: busy || approved }, busy ? t("accepting") : (approved ? t("approveSuccess") : t("accept"))),
					error && react.createElement("p", { style: styles.error }, error),
				),
			);
		}

		/** IDLE workflow chooser as a sibling view of 对话/轨迹. */
		function IdleWorkflowView(props) {
			const { sessions, api, getCommands, inputActions, useInput, t } = props;
			const state = useModeGateState(sessions, api);
			const { workflows, sessionId } = useWorkflows(sessions, api);
			/* Draft source: the framework session kit first, DOM polling as the backstop. */
			const polled = useComposerState();
			const liveDraft = typeof useInput === "function" ? useInput((state) => state.draft) : null;
			const draft = typeof liveDraft === "string" ? liveDraft : polled.text;
			const hasText = draft.trim().length > 0;
			const [busy, setBusy] = react.useState(false);

			const pending = state.pendingProtocol && state.pendingProtocol.status === "awaiting_user" ? state.pendingProtocol : null;
			const isIdle = !state.workflowId || state.workflowId === "IDLE";
			const inInit = state.workflowId === "create" && state.phase === "INIT";
			const [picked, setPicked] = react.useState([]);
			const [pickError, setPickError] = react.useState("");
			react.useEffect(() => {
				if (!isIdle && !pending && !inInit) activateChatView();
			}, [isIdle, pending, inInit]);
			if (pending) {
				return react.createElement(FeatureIntentApprovalView, { sessions, api, sessionId, t });
			}
			/* INIT 阶段：先由用户从 feature 树里挑选 overview / feature intent。 */
			if (inInit) {
				const submit = async (selection) => {
					if (busy) return;
					if (!Array.isArray(selection) || selection.length === 0) {
						setPickError("请选择至少一个 feature overview 或 feature intent");
						return;
					}
					setBusy(true);
					setPickError("");
					try {
						const result = await api().submitFeatureSelection({ sessionId, selection });
						const submitted = result && result.ok ? (result.value || {}) : null;
						if (!result || result.ok === false || (submitted && submitted.ok === false)) {
							setPickError(String((submitted && submitted.error) || (result && result.error) || "提交失败"));
						} else {
							activateChatView();
						}
					} catch (err) {
						setPickError(String((err && err.message) || err));
					} finally {
						setBusy(false);
					}
				};
				return react.createElement("div", {
					style: {
						height: "100%", width: "100%", overflowY: "auto",
						padding: "28px 32px", display: "flex", flexDirection: "column",
						alignItems: "center", gap: 12,
					},
				},
					react.createElement("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 20, fontWeight: 600 } }, "选择本次要处理的 feature"),
					react.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, textAlign: "center" } },
						"点文件夹右侧箭头展开/收起，点节点主体选中；overview 与 feature intent 均可多选（两者不能混选），提交后进入需求分解。",
						react.createElement("br"),
						react.createElement("span", null, "overview 就是文件夹：可以收录 feature intent，也可以再收录别的 overview。"),
						react.createElement("br"),
						react.createElement("span", null, "本阶段 AI 不会回复（禁言），请先提交选择再继续对话。"),
						react.createElement("br"),
						// 界面版本标记：插件的浏览器端 bundle 会被宿主以 immutable 缓存，
						// 浏览器缓存旧 bundle 时现象是「树永远是空的 / Remote 报参数错误」。
						// 这行小字用来一眼确认页面跑的是不是最新前端。
						react.createElement("span", { style: { fontSize: 11, opacity: 0.6 } }, "界面版本 mg-client/multiroot-6")),
					react.createElement("div", { style: { width: "100%", maxWidth: 720 } },
						react.createElement(FeatureTreePicker, {
							api, t, busy, selected: picked, onSelectedChange: setPicked,
							onError: setPickError, onSubmit: submit, sessionId,
						})
					),
					pickError
						? react.createElement("div", { style: { color: "var(--dsw-alias-label-error, #d33)", fontSize: 12 } }, pickError)
						: null
				);
			}
			if (!isIdle) return react.createElement("div", { style: { display: "none" } });

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

		function firstGoalLine(text) {
			const value = String(text || '').trim();
			if (!value) return '';
			const line = value.split(/\r?\n/)[0].trim();
			return line.replace(/^\[目标\]\s*/, '') || line;
		}

		/** Input-dock goal strip: current goal + expandable remaining checklist goals (DSH tasks style). */
		function ModeGateGoalDock(props) {
			const { sessions, api } = props;
			const state = useModeGateState(sessions, api);
			const [expanded, setExpanded] = react.useState(false);
			const workflowId = state.workflowId || "IDLE";
			if (workflowId === "IDLE") return null;
			const goalPrompt = state.goal && state.goal.status === "active" && state.goal.prompt
				? String(state.goal.prompt)
				: "";
			const full = goalPrompt || state.phase || workflowId;
			const currentText = firstGoalLine(full);
			const staticItems = state.staticPlan && Array.isArray(state.staticPlan.items) ? state.staticPlan.items : [];
			const dynamicItems = state.dynamicPlan && Array.isArray(state.dynamicPlan.items) ? state.dynamicPlan.items : [];
			const items = staticItems.length > 0
				? staticItems.map((item) => ({ id: item.id, text: item.text, status: item.status }))
				: dynamicItems.map((item, index) => ({ id: item.id || `dynamic-${index + 1}`, text: item.content, status: item.status }));
			const done = items.filter((item) => item.status === "completed").length;
			const hasItems = items.length > 0;
			return react.createElement("div", {
				style: {
					width: "min(calc(var(--dsh-composer-card-max-width, 780px) + 2 * var(--dsh-composer-side-clearance, 16px)), 100%)",
					alignSelf: "center", boxSizing: "border-box",
					padding: "0 var(--dsh-composer-side-clearance, 16px)",
				},
			},
				react.createElement("div", {
					style: {
						boxSizing: "border-box",
						width: "100%",
						border: "1px solid var(--dsw-alias-border-l1)",
						background: "var(--dsw-specific-tip)",
						borderRadius: 12,
						padding: "4px 5px 4px 12px",
						display: "flex",
						flexDirection: "column",
						gap: 2,
					},
					title: full,
				},
					react.createElement("div", {
						onClick: hasItems ? () => setExpanded((value) => !value) : undefined,
						style: { display: "flex", alignItems: "center", gap: 10, minHeight: 36, cursor: hasItems ? "pointer" : "default" },
					},
						react.createElement("span", {
							style: { color: "var(--dsw-alias-label-primary)", flex: "none", fontSize: 13, fontWeight: 500, lineHeight: "24px" },
						}, "目标"),
						react.createElement("span", {
							style: { minWidth: 0, color: "var(--dsw-alias-label-primary-dimmed)", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, fontSize: 13, lineHeight: "20px", overflow: "hidden" },
						}, currentText),
						hasItems ? react.createElement("span", { style: { flex: "none", color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, `${done}/${items.length}`) : null,
						hasItems ? react.createElement("span", { style: { flex: "none", color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, expanded ? "▾" : "▸") : null,
					),
					expanded && hasItems ? react.createElement("div", {
						style: { borderTop: "1px solid var(--dsw-alias-border-l1)", padding: "6px 4px 6px 0", display: "flex", flexDirection: "column", gap: 4 },
					},
						items.map((item) => react.createElement("div", {
							key: item.id,
							style: { display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, lineHeight: "18px" },
						},
							react.createElement("span", {
								style: { flex: "none", width: 16, color: item.status === "completed" ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-secondary)" },
							}, item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]"),
							react.createElement("span", {
								style: { minWidth: 0, color: item.status === "completed" ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-primary-dimmed)", textDecoration: item.status === "completed" ? "line-through" : "none" },
							}, item.text),
						)),
					) : null,
				),
			);
		}

		/** Top-of-conversation mode badge + phase progress modal (same header slot as agent preset). */
		function ModeGateModeBadge(props) {
			const { sessions, api } = props;
			const state = useModeGateState(sessions, api);
			const [open, setOpen] = react.useState(false);
			const workflowId = state.workflowId || "IDLE";
			if (workflowId === "IDLE") return null;
			const workflow = state.workflow;
			const states = workflow && Array.isArray(workflow.states) ? workflow.states : [];
			const currentIndex = workflow && Number.isInteger(workflow.phaseIndex)
				? workflow.phaseIndex
				: states.findIndex((entry) => entry.id === state.phase);
			const current = states[currentIndex] || { id: state.phase, label: state.phase };
			const previous = currentIndex > 0 ? states[currentIndex - 1] : null;
			const next = currentIndex >= 0 && currentIndex < states.length - 1 ? states[currentIndex + 1] : null;
			const completed = currentIndex > 0 ? states.slice(0, currentIndex) : [];
			const label = `${(workflow && workflow.label) || workflowId} · ${current.label || current.id}`;
			const phaseLine = (title, entry) => react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "baseline" } },
				react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, flex: "none", width: 56 } }, title),
				react.createElement("span", { style: { color: entry ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-tertiary)", fontSize: 13 } }, entry ? (entry.label || entry.id) : "—"),
			);
			return react.createElement(react.Fragment, null,
				react.createElement("button", {
					type: "button",
					onClick: () => setOpen((value) => !value),
					title: "查看阶段进度",
					style: {
						cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)",
						background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)",
						borderRadius: 999, padding: "2px 10px", fontSize: 12, lineHeight: "20px", maxWidth: 220,
						overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
					},
				}, label),
				open ? react.createElement("div", {
					onClick: () => setOpen(false),
					style: {
						position: "fixed", inset: 0, zIndex: 1200,
						background: "rgba(0,0,0,0.28)", display: "flex", alignItems: "flex-start", justifyContent: "center",
						paddingTop: 72,
					},
				},
					react.createElement("div", {
						onClick: (event) => event.stopPropagation(),
						style: {
							width: "min(420px, calc(100vw - 32px))", boxSizing: "border-box",
							background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)",
							border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12,
							boxShadow: "var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,0.28))", padding: "12px 14px",
							display: "flex", flexDirection: "column", gap: 10,
						},
					},
						react.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 } },
							react.createElement("span", { style: { fontWeight: 600, fontSize: 14 } }, label),
							react.createElement("button", { onClick: () => setOpen(false), style: { cursor: "pointer", border: "none", background: "transparent", color: "var(--dsw-alias-label-tertiary)", fontSize: 16, lineHeight: "16px" } }, "×"),
						),
						phaseLine("当前阶段", current),
						phaseLine("上一阶段", previous),
						phaseLine("下一阶段", next),
						react.createElement("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l1)", paddingTop: 8 } },
							react.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginBottom: 4 } }, `已完成阶段（${completed.length}）`),
							completed.length
								? react.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } }, completed.map((entry) => react.createElement("span", {
									key: entry.id,
									style: { background: "var(--dsw-alias-bg-module-platform)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 999, padding: "1px 8px", fontSize: 11, color: "var(--dsw-alias-label-secondary)" },
								}, entry.label || entry.id)))
								: react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, "暂无"),
						),
					),
				) : null,
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
			const state = useModeGateState(sessions, api);
			const isIdle = status.idle;
			const hidden = useIdleModalHidden();
			const prevShown = react.useRef(null);
			const hasPending = Boolean(state.pendingProtocol && state.pendingProtocol.status === "awaiting_user");
			/* INIT 阶段：由用户先选 feature overview / intent，工作流界面必须可见。 */
			const inInit = state.workflowId === "create" && state.phase === "INIT";

			react.useEffect(() => {
				const show = hasPending || inInit || (isIdle && status.loaded && !hidden);
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
			}, [isIdle, status.loaded, hidden, hasPending, inInit, setView]);

			if (!isIdle && !hasPending && !inInit) return null;
			if (hasPending || inInit) {
				return react.createElement("button", {
					onClick: () => {
						if (typeof setView === "function") setView("mode-gate-idle");
						else if (typeof document !== "undefined") {
							const tabs = document.querySelectorAll('[role="tab"]');
							for (const tab of tabs) {
								if (tab.textContent && tab.textContent.includes("工作流")) { tab.click(); return; }
							}
						}
					},
					title: hasPending ? "查看待确认的需求协议" : "选择本次要处理的 feature",
					style: {
						cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)",
						background: "var(--dsw-alias-bg-module-platform)", color: "var(--dsw-alias-label-primary)",
						borderRadius: 8, padding: "3px 8px", fontSize: 12,
					},
				}, hasPending ? "查看需求确认" : "选择 feature");
			}
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
			const { sessions, api, useInput, t } = props;
			const pendingPlaceholderText = typeof t === "function" ? t("pendingPlaceholder") : "在这里输入内容并发送以修改需求或者评论理解。";
			const state = useModeGateState(sessions, api);
			const isIdle = !state.workflowId || state.workflowId === "IDLE";
			const pending = Boolean(state.pendingProtocol && state.pendingProtocol.status === "awaiting_user");
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
					document.body.classList.remove("mode-gate-pending-composer");
				};
				const apply = () => {
					if (pending) {
						document.body.classList.remove("mode-gate-idle-composer");
						document.body.classList.add("mode-gate-pending-composer");
						const el = findComposerTextarea();
						if (!el) return;
						if (!el.dataset.modeGatePlaceholder) {
							el.dataset.modeGatePlaceholder = el.getAttribute("placeholder") || "";
						}
						el.setAttribute("placeholder", pendingPlaceholderText);
						return;
					}
					if (isIdle) {
						document.body.classList.remove("mode-gate-pending-composer");
						document.body.classList.add("mode-gate-idle-composer");
						const el = findComposerTextarea();
						if (!el) return;
						if (!el.dataset.modeGatePlaceholder) {
							el.dataset.modeGatePlaceholder = el.getAttribute("placeholder") || "";
						}
						if (el.getAttribute("placeholder") !== "") el.setAttribute("placeholder", "");
						return;
					}
					restore();
				};
				apply();
				// The composer textarea can be re-created on session switches.
				const timer = setInterval(apply, 500);
				return () => { clearInterval(timer); restore(); };
			}, [isIdle, pending]);

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

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "mode-gate",
				order: 50,
				label: () => t("tab"),
				locale: NS,
				inject: () => ({ api, getModelCatalog: () => { const session = ctx.get("remote.session"); return session ? session.modelCatalog() : Promise.resolve(null); } })
			}, ModeGateSettingsSection));

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
				order: 1,
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

			// Non-IDLE mode+goal strip, visually aligned with the native GoalBar.
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "mode-gate-goal-dock",
				order: 6,
				locale: NS,
				inject: () => ({ sessions: ctx.get("sessions"), api })
			}, ModeGateGoalDock));

			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "mode-gate-mode-badge",
				order: -20,
				locale: NS,
				inject: () => ({ sessions: ctx.get("sessions"), api })
			}, ModeGateModeBadge));

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
