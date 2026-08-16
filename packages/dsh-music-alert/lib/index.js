import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { readdirSync, writeFileSync, unlinkSync, mkdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

const AUDIO_EXT = [".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"];
const PLAYER_CANDIDATES = ["afplay", "ffplay", "mpg123", "aplay", "paplay"];

/**
 * Decorate a class's public instance methods as `@Remote` markers without the
 * TypeScript decorator compiled helpers. Each named method becomes a direct
 * Remote marker (`Remote(name)`), exactly what the `@Remote("x")` decorator
 * does; the resulting initializers are run against an object whose prototype is
 * the class prototype so `remoteMethods(service)` discovers them.
 */
function markRemoteMethods(cls, methodNames) {
  const initializers = [];
  for (const name of methodNames) {
    Remote(name)(undefined, {
      kind: "method",
      name,
      static: false,
      private: false,
      access: { has: (o) => name in o, get: (o) => o[name] },
      addInitializer: (fn) => { initializers.push(fn); },
    });
  }
  const proto = cls.prototype;
  const probe = Object.create(proto);
  for (const fn of initializers) fn.call(probe);
}

/** Expand a leading `~` into the user home directory, or fall back to `~/.dsh/music`. */
function resolveMusicDir(value) {
  if (!value) return join(homedir(), ".dsh", "music");
  if (value.startsWith("~")) return join(homedir(), value.slice(1));
  return value;
}

/** Pick the first available audio player binary; `afplay` (macOS) is the last-resort default. */
function detectPlayer(configured) {
  if (configured) return configured;
  for (const candidate of PLAYER_CANDIDATES) {
    try {
      if (spawnSync("which", [candidate]).status === 0) return candidate;
    } catch (_e) { /* keep probing */ }
  }
  return "afplay";
}

/** Player-specific argv for a detached, unref'd spawn. */
function playerArgs(player, absPath) {
  if (player === "ffplay") return ["-nodisp", "-autoexit", absPath];
  // afplay / mpg123 / aplay / paplay all accept a single path argument.
  return [absPath];
}

/** Build the shared runtime state owned by this plugin instance. */
function buildRuntime(config) {
  const musicDir = resolveMusicDir(config && config.musicDir);
  mkdirSync(musicDir, { recursive: true });

  const statePath = join(musicDir, ".state.json");
  let state = {
    enabled: !config || config.enabled !== false,
    defaultFile: (config && config.defaultFile) || "complete.mp3",
  };
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        state = { ...state, ...parsed };
      }
    } catch (_e) { /* corrupt state file: fall back to defaults */ }
  }

  const player = detectPlayer(config && config.player);

  function sanitize(name) {
    if (typeof name !== "string") return null;
    const base = basename(name);
    if (!base || base === "." || base === ".." || base.includes("..")) return null;
    const lower = base.toLowerCase();
    if (!AUDIO_EXT.some((ext) => lower.endsWith(ext))) return null;
    return base;
  }

  function saveState() {
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  function playFile(name) {
    const target = name || state.defaultFile;
    const safe = sanitize(target);
    if (!safe) return { ok: false, error: "bad name" };
    const abs = join(musicDir, safe);
    if (!existsSync(abs)) return { ok: false, error: "not found" };
    try {
      spawn(player, playerArgs(player, abs), { stdio: "ignore", detached: true }).unref();
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
    return { ok: true, name: safe, player };
  }

  function listFiles() {
    let files = [];
    try {
      files = readdirSync(musicDir)
        .filter((entry) => AUDIO_EXT.some((ext) => entry.toLowerCase().endsWith(ext)))
        .map((entry) => {
          let size = 0;
          try { size = statSync(join(musicDir, entry)).size; } catch (_e) { /* size stays 0 */ }
          return { name: entry, size, isDefault: entry === state.defaultFile };
        });
    } catch (_e) { /* directory missing/unreadable: report empty list */ }
    return { files, defaultFile: state.defaultFile, enabled: state.enabled, player };
  }

  return {
    musicDir,
    statePath,
    state,
    player,
    sanitize,
    playFile,
    listFiles,
    saveState,
  };
}

/**
 * Remote service (namespace `musicAlert`) exposing list/save/remove/play/
 * setDefault/setEnabled. Instantiated manually inside `apply`; the base class
 * registers it as the "musicAlert" service under the owning fiber.
 */
class MusicAlertGateway extends TypertRemoteService {
  static inject = [];

  constructor(ctx, config) {
    super(ctx, "musicAlert");
    this.runtime = config.runtime;
  }

  async list() {
    return this.runtime.listFiles();
  }

  async save(args) {
    const name = this.runtime.sanitize(args && args.name);
    if (!name) return { ok: false, error: "bad name" };
    writeFileSync(join(this.runtime.musicDir, name), Buffer.from((args && args.base64) || "", "base64"));
    return { ok: true, name };
  }

  async remove(args) {
    const name = this.runtime.sanitize(args && args.name);
    if (!name) return { ok: false, error: "bad name" };
    unlinkSync(join(this.runtime.musicDir, name));
    return { ok: true };
  }

  async play(args) {
    return this.runtime.playFile(args && args.name ? args.name : "");
  }

  async setDefault(args) {
    const name = this.runtime.sanitize(args && args.name);
    if (!name || !existsSync(join(this.runtime.musicDir, name))) return { ok: false, error: "not found" };
    this.runtime.state.defaultFile = name;
    this.runtime.saveState();
    return { ok: true, defaultFile: name };
  }

  async setEnabled(args) {
    this.runtime.state.enabled = !!args.enabled;
    this.runtime.saveState();
    return { ok: true, enabled: this.runtime.state.enabled };
  }
}

markRemoteMethods(MusicAlertGateway, ["list", "save", "remove", "play", "setDefault", "setEnabled"]);

const SKILL_CONTENT = [
  "# play-music 提醒音",
  "",
  "在需要声音提醒用户时，调用 `play_music` 工具播放提示音/音乐。",
  "",
  "## 何时调用",
  "- 长构建、长测试、长任务完成，需要主动提醒用户时；",
  "- 用户明确要求播放音乐或提示音时。",
  "",
  "## 用法",
  "- 调用 `play_music` 工具；可选参数 `file` 指定文件名，省略则播放默认音。",
  "- 音乐文件统一放在 `~/.dsh/music` 目录下（支持 mp3/wav/m4a/ogg/flac/aac）。",
].join("\n");

function apply(ctx, config) {
  const runtime = buildRuntime(config);
  const minGapSeconds = (config && Number.isFinite(config.minGapSeconds) && config.minGapSeconds > 0) ? config.minGapSeconds : 0;
  const minGapMs = minGapSeconds * 1000;
  let lastPlayAt = 0;

  // 1. Auto-play the default sound whenever an agent finishes a turn (goes idle).
  ctx.on("agent/status", (payload) => {
    if (!(payload && payload.status === "idle" && runtime.state.enabled)) return;
    const now = Date.now();
    if (minGapMs > 0 && now - lastPlayAt < minGapMs) return;
    lastPlayAt = now;
    try {
      const result = runtime.playFile(runtime.state.defaultFile);
      console.log("[dsh-music-alert] auto-play:", result);
    } catch (err) {
      console.error("[dsh-music-alert] auto-play failed:", err);
    }
  });

  // 2. `play_music` tool: let the agent play a sound on demand.
  ctx.tools.register({
    name: "play_music",
    description: "播放 ~/.dsh/music 下的一首音乐/提示音，用于长任务完成时提醒用户；file 省略则播默认音。",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "文件名（可选）" },
      },
      required: [],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          name: { type: "string" },
          player: { type: "string" },
          error: { type: "string" },
        },
        required: ["ok"],
      },
      render: (_args, value) => {
        if (value && value.ok) return [{ type: "text", text: `已播放 ${value.name || ""}（${value.player || "unknown"}）` }];
        return [{ type: "text", text: `播放失败：${(value && value.error) || "unknown"}` }];
      },
    },
    async execute(args) {
      return runtime.playFile(args && args.file ? args.file : "");
    },
  });

  // 3. `play-music` skill: guide the agent on when/how to use `play_music`.
  ctx.skills.register({
    name: "play-music",
    description: "在长任务完成或用户需要声音提醒时，用 play_music 工具播放 ~/.dsh/music 下的提示音。",
    source: "runtime",
    content: SKILL_CONTENT,
  });

  // 4. Remote service for the browser settings panel.
  new MusicAlertGateway(ctx, { runtime });
}

export { MusicAlertGateway };
export default { name: "dsh-music-alert", inject: ["tools", "skills"], apply };
