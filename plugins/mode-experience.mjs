// Mode-experience injector (host plane, profile cordis.patch.yml).
// On each system-prompt assembly, resolve the active preset and inject
// DOCUMENT/{preset}.md.
import { readdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export default {
  name: 'mode-experience',
  // Hard dependencies: wait for these services before apply, so ctx.systemPrompt
  // and ctx.agentPresets are guaranteed to be present at apply time.
  inject: ['systemPrompt', 'agentPresets'],

  apply(ctx, config) {
    const docDir = (config && config.docDir) || ''
    const logFile = join(docDir, '.mode-experience.log')
    const log = (msg) => { try { appendFileSync(logFile, msg + '\n') } catch (e) {} }
    let textLogged = false

    const cache = {}
    if (docDir && existsSync(docDir)) {
      try {
        for (const entry of readdirSync(docDir)) {
          if (entry.endsWith('.md')) {
            cache[entry.slice(0, -3)] = readFileSync(join(docDir, entry), 'utf8')
          }
        }
      } catch (err) {
        log('PRELOAD ERROR: ' + (err && err.message))
      }
    }
    log('APPLY files=' + JSON.stringify(Object.keys(cache)) + ' systemPrompt=' + !!ctx.systemPrompt + ' agentPresets=' + !!ctx.agentPresets)

    const presetOf = (agent) => {
      if (!agent) return undefined
      try { return ctx.agentPresets.composedPreset(agent.ctx) } catch (e) { return undefined }
    }

    ctx.systemPrompt.section({
      name: 'mode-experience',
      order: 500,
      text: (assembleCtx) => {
        const agent = assembleCtx && assembleCtx.agent
        const preset = presetOf(agent)
        if (!textLogged) {
          textLogged = true
          log('TEXT preset=' + JSON.stringify(preset) + ' hasAgent=' + !!agent)
        }
        if (!preset) return ''
        const content = cache[preset]
        if (!content) return ''
        return '## 模式经验 (' + preset + ')\n\n' + content
      },
    })
    log('SECTION REGISTERED')
  },
}
