// Mode-experience injector (host plane, profile cordis.patch.yml).
// - DOCUMENT/GENERAL.md -> injected into every mode's sessions (resident)
// - DOCUMENT/{mode}.md -> parsed into on-demand skills, one per `#### [slug]` section
// - also registers an on-demand index skill "mode-experience" listing all parsed skills
import { readdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function expandHome(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return dir
  if (dir === '~') return homedir()
  if (dir.startsWith('~/')) return join(homedir(), dir.slice(2))
  return dir
}

function sanitizeKebab(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section'
}

const HEADING_RE = /^####\s*(?:\[([a-z0-9-]+)\]\s*)?(.*)$/

// Split content into sections on `####` headings. Content before the first
// heading (preamble) is dropped. Each section = { slug, fallbackIndex, title, lines }.
function parseSections(content) {
  const lines = content.split('\n')
  const sections = []
  let current = null
  let index = 0
  for (const line of lines) {
    const m = HEADING_RE.exec(line)
    if (m) {
      index += 1
      if (current) sections.push(current)
      current = {
        slug: m[1] || null,
        fallbackIndex: index,
        title: (m[2] || '').trim(),
        lines: [],
      }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) sections.push(current)
  return sections
}

export default {
  name: 'mode-experience',
  inject: ['systemPrompt', 'agentPresets', 'skills'],

  apply(ctx, config) {
    const docDir = expandHome((config && config.docDir) || '')
    const logFile = join(docDir, '.mode-experience.log')
    const log = (msg) => { try { appendFileSync(logFile, msg + '\n') } catch (e) {} }

    let generalContent = ''
    const files = {}   // mode name -> raw file content (non-GENERAL .md files)

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

    // Parse every non-GENERAL file into skills.
    const usedNames = new Map()
    const allSkills = []   // { mode, name, title }

    const allocateName = (mode, slug) => {
      const name = sanitizeKebab(`${mode}-${slug}`)
      if (!usedNames.has(name)) {
        usedNames.set(name, 1)
        return name
      }
      const next = usedNames.get(name) + 1
      usedNames.set(name, next)
      const dedup = `${name}-${next}`
      log(`WARN duplicate skill name "${name}" -> "${dedup}"`)
      return dedup
    }

    const buildDescription = (title, body) => {
      let description = title || ''
      if (body) {
        const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || ''
        if (firstLine && firstLine.length <= 80) {
          const appended = description + ' — ' + firstLine
          description = appended.length > 120 ? appended.slice(0, 120) : appended
        }
      }
      return description
    }

    for (const mode of Object.keys(files).sort()) {
      const content = files[mode]
      const sections = parseSections(content)

      if (sections.length === 0) {
        // No `####` heading: register the whole file as one overview skill.
        const body = content.trim()
        const title = `${mode} 经验`
        const name = allocateName(mode, 'overview')
        const description = buildDescription(title, body)
        const skillContent = '# ' + title + (body ? '\n\n' + body : '')
        ctx.skills.register({ name, description, source: 'runtime', content: skillContent })
        allSkills.push({ mode, name, title })
        log(`SKILL ${name} (overview of ${mode})`)
        continue
      }

      for (const sec of sections) {
        const slug = sec.slug || `${mode}-${sec.fallbackIndex}`
        const title = sec.title || slug
        const body = sec.lines.join('\n').trim()
        const name = allocateName(mode, slug)
        const description = buildDescription(title, body)
        const skillContent = '# ' + title + (body ? '\n\n' + body : '')
        ctx.skills.register({ name, description, source: 'runtime', content: skillContent })
        allSkills.push({ mode, name, title })
        log(`SKILL ${name} (${mode} / ${slug})`)
      }
    }

    log('APPLY modes=' + JSON.stringify(Object.keys(files)) + ' general=' + (generalContent ? 'yes' : 'no') + ' skills=' + allSkills.length)

    // Auto-inject GENERAL.md only (all modes).
    ctx.systemPrompt.section({
      name: 'mode-experience',
      order: 500,
      text: () => generalContent || '',
    })

    // On-demand index skill: lists every parsed skill grouped by mode.
    const byMode = {}
    for (const s of allSkills) {
      ;(byMode[s.mode] = byMode[s.mode] || []).push(s)
    }
    const indexLines = []
    for (const mode of Object.keys(byMode).sort()) {
      const names = byMode[mode].map((s) => `\`${s.name}\``).join('、')
      indexLines.push(`- \`${mode}\` -> ${names}`)
    }
    const skillContent = [
      '# mode-experience 插件',
      '',
      '把经验文件（`DOCUMENT/{mode}.md`）按 `####` 分节解析成按需加载的 skill；`GENERAL.md` 常驻注入 system prompt。',
      '',
      '## 经验 skill 索引',
      ...(indexLines.length ? indexLines : ['（暂无）']),
    ].join('\n')

    ctx.skills.register({
      name: 'mode-experience',
      description: 'mode-experience 插件的文档与经验 skill 索引（经验按需加载）。',
      source: 'runtime',
      content: skillContent,
    })
    log('SKILL mode-experience REGISTERED')
  },
}
