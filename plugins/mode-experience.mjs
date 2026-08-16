// Mode-experience injector (host plane, profile cordis.patch.yml).
// - DOCUMENT/{mode}.md  -> injected only into that mode's sessions
// - DOCUMENT/GENERAL.md -> injected into every mode's sessions
// - also registers an on-demand skill "mode-experience" (plugin doc + index)
import { readdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function expandHome(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return dir
  if (dir === '~') return homedir()
  if (dir.startsWith('~/')) return join(homedir(), dir.slice(2))
  return dir
}

function firstHeading(text) {
  const line = (text || '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) || ''
  return line.replace(/^#+\s*/, '') || '(无标题)'
}

export default {
  name: 'mode-experience',
  inject: ['systemPrompt', 'agentPresets', 'skills'],

  apply(ctx, config) {
    const docDir = expandHome((config && config.docDir) || '')
    const logFile = join(docDir, '.mode-experience.log')
    const log = (msg) => { try { appendFileSync(logFile, msg + '\n') } catch (e) {} }

    const cache = {}   // mode name -> content
    let generalContent = ''

    if (docDir && existsSync(docDir)) {
      try {
        for (const entry of readdirSync(docDir)) {
          if (!entry.endsWith('.md')) continue
          const name = entry.slice(0, -3)
          const content = readFileSync(join(docDir, entry), 'utf8')
          if (name === 'GENERAL') generalContent = content
          else cache[name] = content
        }
      } catch (err) {
        log('PRELOAD ERROR: ' + (err && err.message))
      }
    }
    log('APPLY modes=' + JSON.stringify(Object.keys(cache)) + ' general=' + (generalContent ? 'yes' : 'no'))

    const presetOf = (agent) => {
      if (!agent) return undefined
      try { return ctx.agentPresets.composedPreset(agent.ctx) } catch (e) { return undefined }
    }

    // Auto-inject GENERAL.md (all modes) + the mode-specific file.
    ctx.systemPrompt.section({
      name: 'mode-experience',
      order: 500,
      text: (assembleCtx) => {
        const agent = assembleCtx && assembleCtx.agent
        const preset = presetOf(agent)
        const chunks = []
        if (generalContent) chunks.push(generalContent)
        if (preset && cache[preset]) chunks.push(cache[preset])
        if (chunks.length === 0) return ''
        return chunks.join('\n\n')
      },
    })

    // On-demand skill: plugin doc + index of available experience files.
    const index = []
    if (generalContent) index.push('- `GENERAL.md`（所有模式）— ' + firstHeading(generalContent))
    for (const name of Object.keys(cache).sort()) {
      index.push('- `' + name + '.md` — ' + firstHeading(cache[name]))
    }
    const skillContent = [
      '# mode-experience 插件',
      '',
      '按模式自动注入经验：每次会话开始，把当前模式的经验文件（`DOCUMENT/{mode}.md`）和通用经验（`GENERAL.md`）插入 system prompt。',
      '',
      '## 文件约定',
      '- 目录：`~/.dsh/DOCUMENT/`',
      '- `{mode}.md` → 只注入该模式（mode = preset id，如 cordis）',
      '- `GENERAL.md` → 注入所有模式',
      '- 改文件后重启 `dsh web` 生效',
      '',
      '## 当前经验文档索引',
      ...(index.length ? index : ['（暂无）']),
    ].join('\n')

    ctx.skills.register({
      name: 'mode-experience',
      description: 'mode-experience 插件的文档与当前经验文件索引（按模式自动注入经验）。',
      source: 'runtime',
      content: skillContent,
    })
    log('SKILL REGISTERED')
  },
}
