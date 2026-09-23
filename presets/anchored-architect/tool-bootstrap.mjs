/**
 * Anchored tool bootstrap — keep the FIRST model request on the Minimal
 * preset's REAL tool schema (persistent `bash` + `str_replace_editor`), then
 * narrow the catalog to a minimal RESIDENT set once the session has produced
 * its first durable promotion signal. Injected-context control lives in the
 * companion `context-gate` plugin, not here.
 *
 * The phase is derived from durable session events, so resume and reload
 * preserve it. By default (`promoteOn: 'either'`) a session promotes after the
 * first `tool/call` OR the first `assistant/message`, whichever comes first:
 * request #1 always sees the bootstrap catalog and request #2 always sees the
 * resident catalog. The original `'tool-call'` mode is kept for compatibility,
 * but it can trap a session in bootstrap forever when the first model reply
 * makes no tool call — the `'either'` default removes that trap while keeping
 * the first-request anchor intact.
 *
 * First-request conditions established by the reproduction work (issues #6
 * and #11, 2026-08-15):
 *
 *  1. Tool schema. The API-visible first-request catalog decides whether the
 *     session anchors on the Minimal trajectory. At the adapter-default
 *     maxTokens (256000 on the official endpoint) the Minimal tool pair —
 *     persistent `bash` + `str_replace_editor` — anchored 5/5 runs with zero
 *     `let me` first-lines, while every standard-family schema (pwsh/read,
 *     pwsh only, sandboxed bash/read) fell into standard-like behavior
 *     (11/11). Bootstrap therefore exposes exactly the Minimal pair, not
 *     Standard's `pwsh`/`read`.
 *
 *  2. Output budget. On the official endpoint the first request's `max_tokens`
 *     also dominated the trajectory anchor at 1024 (`We need` style in 26/32
 *     runs against 0/5 at 256000, independent of tool descriptions). The
 *     Minimal tool schema, however, anchors at 256000 WITHOUT any cap, and the
 *     cap's delivery depends on the profile package's `prepareCall` behavior
 *     (it reaches the request on the 0.1.0-rc.5 source checkout; a prebuilt
 *     rc.6-reporting profile package observed in issue #11 overwrote it with
 *     `adapterDefaults.maxTokens`). `bootstrapMaxTokens` is therefore OPT-IN:
 *     leave it unset to run the Minimal schema at the adapter default, or set
 *     it to cap the first request. When set, the cap is stripped after
 *     promotion — the next request's seed proposal carries the previous
 *     header's maxTokens forward, so the release must be explicit.
 *
 *  3. Injected context is NOT this plugin's concern: the companion
 *     `context-gate` plugin (shared/context-gate.mjs, mounted as the FIRST
 *     row) owns the unified injection control — runtime-context suppression
 *     on the assembly path and a claimed-baseline deny on the pre-step
 *     waterfall, both keyed to the same epoch-aware promotion phase. Mount it
 *     separately for context control alone; this file narrows only the tool
 *     catalog (plus the optional output cap below).
 *
 * SUBAGENTS: by default subagents (delegationDepth > 0) are always promoted
 * (resident catalog from their first request). `includeSubagents: true`
 * makes them follow the same bootstrap phase — their first request also sees
 * the bootstrap pair, and their own first reply or tool call promotes them.
 * Keep this flag in sync with the context-gate row's flag.
 *
 * POST-PROMOTION RESIDENT SET (local addition, user-measured): the promoted
 * phase does NOT dump the whole Standard catalog at once — that dump pulls
 * the trajectory back to standard-like behavior (the root cause of the
 * post-promotion regression measured on the zero variant). Instead the
 * catalog narrows to the bootstrap tool pair PLUS the three discovery tools
 * (`dev_tool_search`, `skill_search`, `skill_load`) plus whatever the model
 * explicitly unlocked via `dev_tool_search`, PLUS whatever the user authorized
 * with mode-gate's `/grant` (user intent outranks the narrowing). Heavier Standard tools
 * (web_search, subagent, workflow, …) are one `dev_tool_search` call away;
 * unlocked names are derived from durable `tool/call` events, so resume and
 * reload keep them. read/write/edit/glob/grep/todo/ask are deliberately NOT
 * resident: bash + str_replace_editor cover file work.
 *
 * COMPACTION (local addition): a compaction rewrites the whole surface, so the
 * first post-compaction request is a "second first request". Promotion is
 * epoch-aware (see compaction-epoch.mjs): after `compaction/end` the session
 * falls back to the controlled phase — the bootstrap pair plus
 * `compactionTools` (a core work set, default none) — until a NEW durable
 * promotion signal exists past that boundary. The model is mid-task and needs
 * to keep working, but still faces a small catalog instead of the full
 * Standard set.
 *
 * Robustness:
 *  - Promotion decisions are memoized per session id for this process; the
 *    durable event scan runs once per session per process, then O(1).
 *  - Subagents (delegationDepth > 0) are always promoted (resident catalog)
 *    unless `includeSubagents: true`.
 *  - A missing bootstrap tool degrades to the full catalog with a one-time
 *    warning instead of throwing, so a composition drift can never brick
 *    every request of a session.
 *  - Invalid config (bad tool lists, unknown `promoteOn`, malformed flags,
 *    non-positive `bootstrapMaxTokens`) fails at apply time, i.e. at preset
 *    mount, where it is visible and fixable.
 */

import { createEpochPromotion } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'anchored-tool-bootstrap'

/**
 * Deliberately NO inject list: the listeners only touch services at event
 * time. Keep this row right AFTER the context-gate row in agent.cordis.yml:
 * waterfall after-next transforms apply in reverse registration order, so the
 * tool filter here must register before any plugin that touches the same
 * assembly. The optional budget listener registers with `prepend: true` so a
 * later listener can never override the first-round cap after we set it.
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = []

/** Durable session event types that count as a promotion signal per mode. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['bootstrapTools', 'promoteOn', 'bootstrapMaxTokens', 'compactionTools', 'includeSubagents'])

/** Validate an optional boolean flag with a default. */
function booleanOption(value, field, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name}: ${field} must be a boolean`)
  }
  return value
}

/**
 * The default first-request catalog: the OFFICIAL Minimal preset's exact tool
 * pair — the persistent `bash` shell and `str_replace_editor`. Issue #11
 * measured this schema anchoring 5/5 at the adapter-default maxTokens while
 * every standard-family schema failed 11/11.
 */
const DEFAULT_BOOTSTRAP_TOOLS = ['bash', 'str_replace_editor']

/** Discovery tools always resident after promotion (the tool-search pattern). */
const RESIDENT_DISCOVERY_TOOLS = ['dev_tool_search', 'skill_search', 'skill_load']

/**
 * The host mode-gate's control tools (`dsh-mode-gate` registers these at the
 * host plane). They must survive EVERY catalog narrowing — bootstrap, resident,
 * and compaction — or a gated session deadlocks: the `tools/pre-execute` gate
 * demands `declare_target` before any other tool call, but the model can only
 * call it while the tool stays in the visible catalog. Best-effort: when the
 * gate is not mounted these names simply match nothing, and their absence must
 * never trigger the missing-tool degrade (see `keepTools`).
 */
const GATE_CONTROL_TOOLS = ['declare_target', 'switch_mode']

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name}: ${field} must be a non-empty array of non-empty strings`)
  }
  return [...new Set(value)]
}

function stringListOrEmpty(value, field) {
  if (value === undefined) return []
  return stringList(value, field)
}

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/**
 * Validate the optional first-request output cap. `undefined` means NO cap:
 * the Minimal tool schema anchors at the adapter-default maxTokens, and the
 * cap's delivery is profile-package dependent (see the header note), so it is
 * opt-in rather than the default.
 */
function optionalPositiveInt(value, field) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name}: ${field} must be a positive safe integer`)
  }
  return value
}

/** Register the per-session bootstrap filters. */
export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(
      `${name}: unknown config key(s) ${unknown.join(', ')} — allowed keys: ${[...ALLOWED_KEYS].sort().join(', ')}`,
    )
  }
  const bootstrapTools = stringList(source.bootstrapTools, 'bootstrapTools')
  const promoteEvents = parsePromoteOn(source.promoteOn)
  const bootstrapMaxTokens = optionalPositiveInt(source.bootstrapMaxTokens, 'bootstrapMaxTokens')
  const includeSubagents = booleanOption(source.includeSubagents, 'includeSubagents', false)
  // Core work set exposed after a compaction, before re-promotion. Empty
  // means "no compaction recovery catalog": the session stays on the
  // bootstrap pair until a new promotion signal.
  const compactionTools = stringListOrEmpty(source.compactionTools, 'compactionTools')

  const promotion = createEpochPromotion(promoteEvents, { includeSubagents })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  /**
   * Tool names the USER explicitly authorized for one session via mode-gate's
   * `/grant` slash command.
   *
   * `/grant` writes `state.sessions[<id>].grantedTools` into mode-gate's
   * durable state file (`~/.dsh/mode-gate-state.json`) — NOT into the session
   * log, because the harness has no public API to append a synthetic
   * `tool/call` block and faking one would break the call/result pairing
   * invariants. This plugin therefore reads that file directly.
   *
   * USER INTENT OUTRANKS THE NARROWING: a granted name is merged into the
   * keep-set exactly like a `dev_tool_search` unlock, so `/grant foo` makes
   * `foo` visible from the next request on. A missing/unreadable file simply
   * contributes nothing (the narrowing must never fail because mode-gate is
   * not mounted).
   *
   * Read is mtime-cached: `/grant` can fire mid-session and the file is read
   * at most once per change.
   */
  const MODE_GATE_STATE_FILE = join(homedir(), '.dsh', 'mode-gate-state.json')
  let grantCache = { mtimeMs: -1, bySession: new Map() }
  const grantedFor = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return new Set()
    try {
      const stat = statSync(MODE_GATE_STATE_FILE)
      if (stat.mtimeMs !== grantCache.mtimeMs) {
        const raw = JSON.parse(readFileSync(MODE_GATE_STATE_FILE, 'utf8'))
        const sessions = raw && typeof raw.sessions === 'object' && raw.sessions !== null ? raw.sessions : {}
        const bySession = new Map()
        for (const [id, entry] of Object.entries(sessions)) {
          const list = entry && Array.isArray(entry.grantedTools) ? entry.grantedTools : []
          const names = list.filter((n) => typeof n === 'string' && n.length > 0)
          if (names.length > 0) bySession.set(id, new Set(names))
        }
        grantCache = { mtimeMs: stat.mtimeMs, bySession }
      }
    } catch {
      // Missing file / parse error / no permission: contribute nothing.
      return new Set()
    }
    return grantCache.bySession.get(sessionId) ?? new Set()
  }

  /**
   * Tool names the model explicitly unlocked via `dev_tool_search` for one
   * session. Derived from durable `tool/call` events so resume/reload keeps
   * them. The event's `arguments` is the raw JSON string the model produced;
   * we parse it defensively and read the `toolNames` array.
   */
  const unlockedFor = (session) => {
    const unlocked = new Set()
    if (session === undefined) return unlocked
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'tool/call') continue
      if (event.data?.name !== 'dev_tool_search') continue
      let args
      try {
        args = JSON.parse(event.data.arguments)
      } catch {
        continue
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
      const names = args.toolNames
      if (Array.isArray(names)) for (const name of names) if (typeof name === 'string' && name.length > 0) unlocked.add(name)
    }
    // User-authorized tools (/grant) join the same keep-set: the user asked
    // for them explicitly, so the catalog narrowing must not hide them.
    for (const name of grantedFor(session.id)) unlocked.add(name)
    return unlocked
  }

  /**
   * Narrow the assembled catalog to a keep-set; validate required names.
   *
   * `dynamic` names (the gate escape hatch plus user `/grant` authorizations)
   * are merged AFTER the missing check: they are intentionally outside the
   * static phase list, so their absence must neither warn nor degrade — they
   * simply match whatever happens to be assembled.
   */
  const keepTools = (assembled, keep, missingAllowsFullCatalog, dynamic) => {
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const dynamicSet = dynamic instanceof Set ? dynamic : new Set()
    const missing = [...keep].filter((toolName) => !available.has(toolName) && !dynamicSet.has(toolName))
    if (missing.length > 0) {
      warnOnce(
        `${name}: expected every phase tool; missing=${JSON.stringify(missing)} — `
        + (missingAllowsFullCatalog ? 'bootstrap disabled, full catalog exposed' : 'continuing with what is available'),
      )
      if (missingAllowsFullCatalog) return assembled
    }
    // Keep the mode gate's escape hatch regardless of phase. Merged AFTER the
    // missing check so a gate tool that is absent (gate not mounted) neither
    // triggers the degrade above nor breaks the filter below — it just matches
    // nothing.
    const keepPlusGate = new Set([...keep, ...GATE_CONTROL_TOOLS, ...dynamicSet])
    return {
      ...assembled,
      tools: assembled.tools.filter((tool) => keepPlusGate.has(tool.name)),
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    // Downstream errors propagate untouched; only this filter's own logic is guarded.
    const assembled = await next()
    try {
      const status = promotion.status(context.agent)
      if (status.promoted) {
        // PROMOTED: keep the minimal resident set — the bootstrap pair + the
        // discovery tools + whatever the model explicitly unlocked via
        // dev_tool_search — instead of dumping the whole Standard catalog at
        // once (the post-promotion regression fix; see the header note).
        // dev_tool_search unlocks and /grant authorizations are "dynamic":
        // never validated against the phase list, only merged into the filter.
        const unlocked = unlockedFor(context.agent?.session)
        const keep = new Set([...bootstrapTools, ...RESIDENT_DISCOVERY_TOOLS])
        return keepTools(assembled, keep, false, unlocked)
      }
      // Controlled phase: the bootstrap pair; after a compaction, plus the
      // compaction work set so mid-task work can continue. Context control is
      // NOT here: the companion `context-gate` plugin owns it (see the header
      // note), so this filter touches only the tool catalog.
      const { boundary } = status
      const keep = new Set(bootstrapTools)
      if (boundary >= 0) for (const toolName of compactionTools) keep.add(toolName)
      // A /grant issued before the first promotion signal must still be honoured
      // (the user asked for the tool; the first-request anchor is a heuristic,
      // not a veto over explicit user intent).
      return keepTools(assembled, keep, true, grantedFor(context.agent?.session?.id))
    } catch (error) {
      // A filter bug must never brick a session: degrade to the full catalog.
      warnOnce(`${name}: bootstrap filter failed, exposing the full catalog: ${String((error && error.message) || error)}`)
      return assembled
    }
  })

  // Optionally cap the first model request's output budget while bootstrapping.
  // Unset (`bootstrapMaxTokens` omitted) means the adapter default flows — the
  // Minimal tool schema anchors at 256000 without a cap (issue #11).
  if (bootstrapMaxTokens !== undefined) {
    // Same registration discipline as the pre-step strip below: `prepend`
    // keeps this listener the OUTERMOST transform of the agent/request
    // waterfall for the same registration-order reasons (loader row
    // application is concurrent; row order alone does not decide listener
    // order — see issue #6 and upstream PR #13), so a later listener can
    // never override the first-round budget after we set it.
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      const agent = payload.agent
      if (promotion.status(agent).promoted) {
        // The next request's seed proposal carries the previous header's
        // maxTokens forward, so the injected cap must be stripped explicitly —
        // otherwise it would persist for the whole session.
        if (resolved.maxTokens === bootstrapMaxTokens) {
          const { maxTokens: _bootstrap, ...rest } = resolved
          return rest
        }
        return resolved
      }
      return {
        ...resolved,
        maxTokens: bootstrapMaxTokens,
      }
    }, { prepend: true })
  }
}
