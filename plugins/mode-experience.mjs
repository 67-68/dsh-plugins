// Mode-experience persona injector (host plane, profile cordis.patch.yml).
//
// Slimmed to ONLY the persona/experience injection role:
// - DOCUMENT/GENERAL.md -> resident system-prompt text for every mode
// - DOCUMENT/{mode}.md  -> resident system-prompt text for that mode
//
// Removed (migrated away): parsing `#### [slug]` sections into on-demand
// skills, the legacy `mode-experience` index skill, and the skills dependency.
// Project-specific knowledge now lives in the project-experience store owned by
// dsh-mode-gate.
import { readdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function expandHome(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return dir
  if (dir === '~') return homedir()
  if (dir.startsWith('~/')) return join(homedir(), dir.slice(2))
  return dir
}

export default {
  name: 'mode-experience',
  inject: ['systemPrompt', 'agentPresets'],

  apply(ctx, config) {
    const docDir = expandHome((config && config.docDir) || '')
    const logFile = join(docDir, '.mode-experience.log')
    const log = (msg) => { try { appendFileSync(logFile, msg + '\n') } catch (e) {} }

    const promoteGatedModes = new Set(
      Array.isArray(config && config.promoteGatedModes) ? config.promoteGatedModes : []
    )

    let generalContent = ''
    const files = {}

    if (docDir && existsSync(docDir)) {
      try {
        for (const entry of readdirSync(docDir)) {
          if (!entry.endsWith('.md')) continue
          const name = entry.slice(0, -3)
          const content = readFileSync(join(docDir, entry), 'utf8')
          if (name === 'GENERAL') generalContent = content
          else files[name] = content
        }
      } catch (err) {
        log('PRELOAD ERROR: ' + (err && err.message))
      }
    }

    log('APPLY (persona-only) modes=' + JSON.stringify(Object.keys(files)) + ' general=' + (generalContent ? 'yes' : 'no'))

    ctx.systemPrompt.section({
      name: 'mode-experience',
      order: 500,
      text: (assembleCtx) => {
        const agent = assembleCtx && assembleCtx.agent
        if (!agent) return generalContent || ''
        let presetId
        try {
          presetId = ctx.agentPresets.composedPreset(agent.ctx)
        } catch (_err) {
          presetId = undefined
        }
        if (presetId !== undefined && promoteGatedModes.has(presetId)) return ''
        const modeDoc = presetId !== undefined && files[presetId] ? files[presetId] : ''
        return [generalContent, modeDoc].filter((part) => typeof part === 'string' && part.trim().length > 0).join('\n\n')
      },
    })
  },
}
