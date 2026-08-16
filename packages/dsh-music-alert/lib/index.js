import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { readdirSync, writeFileSync, unlinkSync, mkdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

const AUDIO_EXT = [".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac", ".aiff", ".caf"];

/** Expand a leading `~` / `~/` against the OS home directory; pass other values through. */
function expandHome(dir) {
  if (typeof dir !== "string" || dir.length === 0) return dir;
  if (dir === "~") return homedir();
  if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
  return dir;
}

/** First available command-line audio player, in preference order. */
function detectPlayer() {
  const candidates = ["afplay", "ffplay", "mpg123", "aplay", "paplay"];
  for (const p of candidates) {
    try {
      if (spawnSync("which", [p], { stdio: "ignore" }).status === 0) return p;
    } catch (_err) {
      /* keep probing */
    }
  }
  return "afplay";
}

/** CLI argument list for the resolved player. */
function playerArgs(player, absPath) {
  switch (player) {
    case "ffplay":
      return ["-nodisp", "-autoexit", absPath];
    default:
      return [absPath];
  }
}

/**
 * Build the shared runtime object consumed by the Host plugin, the play_music
 * tool, and the MusicAlertGateway Remote service. All file I/O is confined to
 * `musicDir`.
 */
function buildRuntime(config) {
  const cfg = config || {};
  const musicDir = expandHome(cfg.musicDir) || join(homedir(), ".dsh", "music");
  mkdirSync(musicDir, { recursive: true });

  const statePath = join(musicDir, ".state.json");
  let state = {
    enabled: cfg.enabled !== false,
    defaultFile: cfg.defaultFile || "complete.mp3",
  };
  if (existsSync(statePath)) {
    try {
      const loaded = JSON.parse(readFileSync(statePath, "utf8"));
      if (loaded && typeof loaded === "object") state = { ...state, ...loaded };
    } catch (_err) {
      /* keep defaults on a corrupt state file */
    }
  }
  const player = cfg.player || detectPlayer();

  return {
    musicDir,
    statePath,
    state,
    player,

    /**
     * Validate a client-supplied filename: it must be a bare basename with an
     * allowed audio extension and no path/`..` traversal. Returns the safe name
     * or `null`.
     */
    sanitize(name) {
      if (typeof name !== "string") return null;
      const base = basename(name);
      if (base.length === 0 || base === "." || base === "..") return null;
      if (base !== name) return null;
      if (name.includes("..")) return null;
      const dot = base.lastIndexOf(".");
      if (dot <= 0) return null;
      const ext = base.slice(dot).toLowerCase();
      if (!AUDIO_EXT.includes(ext)) return null;
      return base;
    },

    /** Play a file by name; empty name falls back to the configured default. */
    playFile(name) {
      const target = typeof name === "string" && name.length > 0 ? name : state.defaultFile;
      const safe = this.sanitize(target);
      if (!safe) {
        console.log("[dsh-music-alert] playFile: bad name", JSON.stringify(target));
        return { ok: false, error: "bad name" };
      }
      const absPath = join(musicDir, safe);
      if (!existsSync(absPath)) {
        console.log("[dsh-music-alert] playFile: not found", absPath);
        return { ok: false, error: "not found" };
      }
      try {
        const child = spawn(player, playerArgs(player, absPath), { stdio: "ignore", detached: true });
        child.on("error", (err) => {
          console.log("[dsh-music-alert] play spawn error:", err && err.message);
        });
        child.unref();
      } catch (err) {
        console.log("[dsh-music-alert] playFile: spawn failed", err && err.message);
        return { ok: false, error: "spawn failed: " + (err && err.message) };
      }
      console.log("[dsh-music-alert] playFile: ok", safe, "player=", player);
      return { ok: true, name: safe, player };
    },

    /** Enumerate every audio file in `musicDir` plus the current playback config. */
    listFiles() {
      let files = [];
      try {
        files = readdirSync(musicDir)
          .filter((n) => this.sanitize(n) !== null)
          .map((n) => {
            let size = 0;
            try {
              size = statSync(join(musicDir, n)).size;
            } catch (_err) {
              /* leave size 0 for unreadable entries */
            }
            return { name: n, size, isDefault: n === state.defaultFile };
          });
        console.log("[dsh-music-alert] listFiles: dir=", musicDir, "count=", files.length);
      } catch (err) {
        console.log("[dsh-music-alert] listFiles error:", err && err.message);
      }
      return { files, defaultFile: state.defaultFile, enabled: state.enabled, player };
    },

    /** Persist the in-memory state to `.state.json`. */
    saveState() {
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    },
  };
}

/** Markdown guidance handed to the model via the `play-music` skill. */
const SKILL_CONTENT = [
  "# play-music 插件",
  "",
  "当长任务（例如长时间构建、批量生成、需要等待的耗时操作）完成，或用户需要声音提醒时，主动调用 `play_music` 工具播放一段提示音。",
  "",
  "## 可用工具",
  "- `play_music`：播放 `~/.dsh/music` 下的一首音乐/提示音。`file` 参数省略时播放默认完成音；指定 `file` 时播放对应文件名。",
  "",
  "## 文件约定",
  "- 音乐文件统一放在 `~/.dsh/music/` 目录。",
  "- 支持扩展名：`.mp3` / `.wav` / `.m4a` / `.ogg` / `.flac` / `.aac`。",
  "- 默认完成音由浏览器 settings 面板（音乐提醒）或 `.state.json` 的 `defaultFile` 指定。",
  "",
  "## 常见场景",
  "- 长构建/长任务完成，需要提醒用户回来看结果。",
  "- 用户明确要求播放某个声音。",
  "",
  "仅在确实需要声音提醒时调用，不要频繁或随意播放。",
].join("\n");

/**
 * No-decorator Remote marker shim. `Remote(name)` is a decorator factory that
 * returns `(method, decoratorContext) => addMarkerInitializer(...)`; feeding it
 * a hand-built method context is enough to record the marker in typert's
 * private WeakMap, exactly like the TS decorator output would.
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
      addInitializer: (fn) => {
        initializers.push(fn);
      },
    });
  }
  const proto = cls.prototype;
  const probe = Object.create(proto);
  for (const fn of initializers) fn.call(probe);
}

/** Remote service exposing the music library to the Web settings tab. */
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
    const name = args && args.name;
    const b64len = (args && typeof args.base64 === "string" && args.base64.length) || 0;
    console.log("[dsh-music-alert] save: name=", name, "base64Len=", b64len);
    const n = this.runtime.sanitize(name);
    if (!n) {
      console.log("[dsh-music-alert] save: sanitize rejected name=", name);
      return { ok: false, error: "bad name" };
    }
    try {
      const absPath = join(this.runtime.musicDir, n);
      writeFileSync(absPath, Buffer.from((args && args.base64) || "", "base64"));
      console.log("[dsh-music-alert] save: wrote", absPath);
    } catch (err) {
      console.log("[dsh-music-alert] save: write failed", err && err.message);
      return { ok: false, error: "write failed: " + (err && err.message) };
    }
    return { ok: true, name: n };
  }
  async deleteFile(args) {
    const n = this.runtime.sanitize(args && args.name);
    if (!n) return { ok: false, error: "bad name" };
    try {
      unlinkSync(join(this.runtime.musicDir, n));
    } catch (err) {
      return { ok: false, error: "remove failed: " + (err && err.message) };
    }
    return { ok: true };
  }
  async play(args) {
    return this.runtime.playFile(args && args.name ? args.name : "");
  }
  async setDefault(args) {
    const n = this.runtime.sanitize(args && args.name);
    if (!n || !existsSync(join(this.runtime.musicDir, n))) return { ok: false, error: "not found" };
    this.runtime.state.defaultFile = n;
    this.runtime.saveState();
    return { ok: true, defaultFile: n };
  }
  async setEnabled(args) {
    this.runtime.state.enabled = !!args.enabled;
    this.runtime.saveState();
    return { ok: true, enabled: this.runtime.state.enabled };
  }
}
markRemoteMethods(MusicAlertGateway, ["list", "save", "deleteFile", "play", "setDefault", "setEnabled"]);

export { MusicAlertGateway };

export default {
  name: "dsh-music-alert",
  inject: ["tools", "skills"],

  apply(ctx, config) {
    const runtime = buildRuntime(config);
    const minGapSeconds = config && typeof config.minGapSeconds === "number" ? config.minGapSeconds : 0;
    let lastPlayAt = 0;

    // Auto-play on turn completion (`agent/status` emits { agent, status }).
    ctx.on("agent/status", (payload) => {
      if (!payload || payload.status !== "idle") return;
      if (!runtime.state.enabled) return;
      const now = Date.now();
      if (minGapSeconds > 0 && now - lastPlayAt < minGapSeconds * 1000) return;
      lastPlayAt = now;
      try {
        const result = runtime.playFile(runtime.state.defaultFile);
        // Silence the expected "no default file yet" case; keep real failures loud.
        if (result && result.ok === false) {
          console.log("[dsh-music-alert] auto-play:", JSON.stringify(result));
        }
      } catch (err) {
        console.log("[dsh-music-alert] auto-play error:", err && err.message);
      }
    });

    // On-demand playback tool for the agent.
    ctx.tools.register({
      name: "play_music",
      description: "播放 ~/.dsh/music 下的一首音乐/提示音，用于长任务完成时提醒用户；file 省略则播默认音。",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "文件名（可选）",
          },
        },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            name: { type: "string" },
            player: { type: "string" },
            error: { type: "string" },
          },
        },
        render: (_args, value) => {
          const text = value && value.ok
            ? `已播放 ${value.name || ""}（${value.player || "系统播放器"}）`
            : `播放失败：${(value && value.error) || "未知错误"}`;
          return [{ type: "text", text }];
        },
      },
      async execute(args) {
        return runtime.playFile(args && args.file ? args.file : "");
      },
    });

    // Guidance skill telling the model when to use `play_music`.
    ctx.skills.register({
      name: "play-music",
      description: "在长任务完成或用户需要声音提醒时，用 play_music 工具播放 ~/.dsh/music 下的提示音。",
      source: "runtime",
      content: SKILL_CONTENT,
    });

    // Mount the Remote service consumed by the Web settings tab.
    new MusicAlertGateway(ctx, { runtime });
  },
};
