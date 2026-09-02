/**
 * persona-gated — complete-prompt persona that stays Minimal-identical until
 * the session promotes, then appends GENERAL.md + {mode}.md as SYSTEM prompt
 * text on a configurable interval (default: the 1st promoted turn and then
 * every 2nd promoted turn; set modeExperienceInterval to change the cadence).
 *
 * Why this file exists: `dsh-persona`'s `complete: true` suppresses every
 * other system-prompt section after assembly. The only section that survives
 * `complete` is the complete section itself. So instead of injecting the mode
 * experience as a separate section (discarded) or as a pre-step user message
 * (read by the model as ordinary user text, not core persona), this plugin
 * REGISTERS THE COMPLETE PERSONA SECTION directly and expands its text once
 * the session promotes.
 *
 * Before promotion the text is byte-identical to the Minimal persona, so the
 * first-request anchor is unchanged. Promotion is epoch-aware via
 * compaction-epoch.mjs: a `compaction/end` demotes, so the first
 * post-compaction request is minimal again (same semantics as context-gate
 * and tool-bootstrap).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createEpochPromotion } from './compaction-epoch.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'persona-gated'

/** The prompt registry is a required dependency for section registration. */
export const inject = ['systemPrompt']

const PROMOTE_EVENTS = ['tool/call', 'assistant/message']

/** The prompt registry's exported constants; hardcoded here to keep this
 * preset-local module free of bare package imports (the installed preset dir
 * resolves bare packages against the repo, not ~/.dsh/profiles). */
const PERSONA_SECTION = 'deployment:persona'
const PERSONA_ORDER = 0

function expandHome(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return dir
  if (dir === '~') return homedir()
  if (dir.startsWith('~/')) return join(homedir(), dir.slice(2))
  return dir
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${name}: expected a boolean`)
  return value
}

function parsePositiveInt(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name}: modeExperienceInterval must be a positive integer`)
  }
  return value
}

function readText(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }

  const basePersona = typeof source.basePersona === 'string'
    ? source.basePersona
    : 'You are a helpful software engineer assistant.'
  const mode = typeof source.mode === 'string' ? source.mode : 'anchored-architect'
  const docDir = expandHome(typeof source.docDir === 'string' ? source.docDir : '~/.dsh/DOCUMENT')
  const includeRuntimeContext = parseBoolean(source.includeRuntimeContext, false)
  const includeSubagents = parseBoolean(source.includeSubagents, false)
  const modeExperienceInterval = parsePositiveInt(source.modeExperienceInterval, 2)

  if (!includeRuntimeContext) ctx.systemPrompt.suppressRuntimeContext()

  // Read once at mount time, matching mode-experience's preload behavior.
  const generalContent = readText(join(docDir, 'GENERAL.md'))
  const modeContent = readText(join(docDir, `${mode}.md`))

  const promotion = createEpochPromotion(PROMOTE_EVENTS, { includeSubagents })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    complete: true,
    text: (assembleCtx) => {
      const agent = assembleCtx && assembleCtx.agent
      if (agent === undefined || agent.session === undefined) return basePersona
      const status = promotion.status(agent)
      if (!status.promoted) return basePersona
      // Inject on the 1st promoted turn, then every N-th promoted turn
      // (N = modeExperienceInterval). Off-turns keep the Minimal persona
      // exactly, so the anchor stays clean while the mode experience still
      // returns on a regular cadence instead of being dropped entirely.
      const first = status.firstPromotedTurn ?? 1
      const promotedTurn = status.turns - first + 1
      if (promotedTurn < 1 || (promotedTurn - 1) % modeExperienceInterval !== 0) return basePersona
      return [basePersona, generalContent, modeContent].filter(Boolean).join('\n\n')
    },
  })
}
