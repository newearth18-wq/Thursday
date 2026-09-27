import type { Note, NoteEntry, RawNote } from '@jupiter/contracts'

/**
 * Markdown notes the way Obsidian reads them (SET 11).
 *
 * Jupiter never rewrites what is already in a note: it parses a note to show
 * it, and when it adds something — a section, a link, a backlink — it
 * inserts new lines and leaves every existing line (frontmatter included)
 * exactly as it was, with the note's own line endings.
 */

const FRONTMATTER = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)/
const WIKILINK = /\[\[([^\]|#^\n]+)(?:[#^][^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g
const INLINE_TAG = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu

export function titleOf(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.md$/i, '')
}

/** A small reader for the frontmatter keys Jupiter shows: `key: value` and `key:` + `- item` lists. */
function properties(yaml: string): Note['properties'] {
  const result: Record<string, string | string[]> = {}
  let listKey: string | null = null
  for (const line of yaml.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && listKey) {
      const current = result[listKey]
      const list = Array.isArray(current) ? current : []
      if (list.length < 100) list.push(unquote(item[1] ?? '').slice(0, 500))
      result[listKey] = list
      continue
    }
    const pair = /^([A-Za-z0-9_\-. ]{1,200}):\s*(.*)$/.exec(line)
    if (!pair) {
      listKey = null
      continue
    }
    const key = (pair[1] ?? '').trim()
    const value = (pair[2] ?? '').trim()
    if (value === '') {
      listKey = key
      result[key] = []
    } else if (/^\[.*\]$/.test(value)) {
      listKey = null
      result[key] = value
        .slice(1, -1)
        .split(',')
        .map((part) => unquote(part.trim()).slice(0, 500))
        .filter(Boolean)
        .slice(0, 100)
    } else {
      listKey = null
      result[key] = unquote(value).slice(0, 2_000)
    }
    if (Object.keys(result).length >= 200) break
  }
  return result
}

function unquote(value: string): string {
  if (/^".*"$/.test(value)) {
    try {
      return String(JSON.parse(value))
    } catch {
      return value.slice(1, -1)
    }
  }
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'")
  return value
}

export function linksIn(text: string): string[] {
  const links = new Set<string>()
  for (const match of text.matchAll(WIKILINK)) {
    const target = (match[1] ?? '').trim()
    if (target) links.add(target)
    if (links.size >= 1_000) break
  }
  return [...links]
}

export function parseNote(raw: RawNote): Note {
  const match = FRONTMATTER.exec(raw.text)
  const frontmatter = match ? (match[2] ?? '') : null
  const body = match ? raw.text.slice(match[0].length) : raw.text
  const props = frontmatter === null ? {} : properties(frontmatter)
  const tags = new Set<string>()
  const declared = props.tags ?? props.tag
  for (const tag of Array.isArray(declared) ? declared : declared ? declared.split(/[\s,]+/) : [])
    if (tag) tags.add(tag.replace(/^#/, ''))
  for (const found of body.matchAll(INLINE_TAG)) if (found[1]) tags.add(found[1])
  return {
    entry: raw.entry,
    frontmatter,
    properties: props,
    body,
    tags: [...tags].slice(0, 200),
    links: linksIn(body),
    hash: raw.hash,
    bom: raw.bom,
    eol: raw.eol
  }
}

/** A YAML string that is always valid: JSON's double-quoted strings are YAML too. */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

/** The text of a new note: frontmatter, title, body, and a Links section. */
export function buildNote(input: {
  title: string
  body: string
  tags: readonly string[]
  links: readonly string[]
  created: string
}): string {
  const lines = [
    '---',
    `title: ${yamlString(input.title)}`,
    `created: ${yamlString(input.created)}`,
    'source: "Jupiter"',
    'tags:',
    ...['jupiter', ...input.tags.filter((tag) => tag !== 'jupiter')].map(
      (tag) => `  - ${yamlString(tag)}`
    ),
    '---',
    '',
    `# ${input.title}`,
    ''
  ]
  const body = input.body.replace(/\r\n?/g, '\n').trim()
  if (body) lines.push(body, '')
  if (input.links.length) {
    lines.push('## Links', '')
    for (const link of input.links) lines.push(`- [[${link}]]`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Adds a section at the end of a note. Everything already in the note stays
 * byte for byte: the new text is appended after it.
 */
export function appendSection(
  text: string,
  heading: string | null,
  content: string,
  eol: '\n' | '\r\n'
): string {
  const block = [
    ...(heading ? [`## ${heading.replace(/\r?\n/g, ' ').trim()}`, ''] : []),
    ...content.trim().split(/\r?\n/)
  ]
  // One blank line between what was there and the new section.
  const separator =
    text.length === 0 ? '' : /\r?\n\r?\n$/.test(text) ? '' : text.endsWith('\n') ? eol : eol + eol
  return `${text}${separator}${block.join(eol)}${eol}`
}

/**
 * Adds `- [[target]]` under `## <section>` unless the note already links to
 * `target` anywhere (links are never duplicated). Existing lines are kept;
 * the new line goes at the end of that section, or a new section is appended.
 */
export function addLink(
  text: string,
  section: string,
  target: string,
  eol: '\n' | '\r\n'
): { text: string; added: boolean } {
  const wanted = target.toLowerCase()
  if (linksIn(text).some((link) => link.toLowerCase() === wanted)) return { text, added: false }
  const line = `- [[${target}]]`
  // Each line keeps its own ending, so nothing already in the note changes.
  const lines = text.split(/(?<=\n)/)
  const bare = (value: string | undefined) => (value ?? '').replace(/\r?\n$/, '')
  const headingIndex = lines.findIndex((candidate) => bare(candidate).trim() === `## ${section}`)
  if (headingIndex < 0) return { text: appendSection(text, section, line, eol), added: true }
  // The end of the section: the next heading of the same or a higher level, or the end.
  let end = lines.length
  for (let index = headingIndex + 1; index < lines.length; index++)
    if (/^#{1,2}\s/.test(bare(lines[index]))) {
      end = index
      break
    }
  let insertAt = end
  while (insertAt > headingIndex + 1 && bare(lines[insertAt - 1]).trim() === '') insertAt--
  const before = lines[insertAt - 1] ?? ''
  if (!before.endsWith('\n')) lines[insertAt - 1] = before + eol
  lines.splice(insertAt, 0, line + eol)
  return { text: lines.join(''), added: true }
}

/** Obsidian's link text for a note: its title, or its path when the title is not unique. */
export function linkTextFor(entry: NoteEntry, all: readonly NoteEntry[]): string {
  const same = all.filter((other) => other.title.toLowerCase() === entry.title.toLowerCase())
  return same.length > 1 ? entry.path.replace(/\.md$/i, '') : entry.title
}

/** The note a link points at, as Obsidian resolves it (by title, or by path without `.md`). */
export function resolveLink(link: string, all: readonly NoteEntry[]): NoteEntry | null {
  const wanted = link.toLowerCase().replace(/\.md$/i, '')
  const byPath = all.find((entry) => entry.path.toLowerCase().replace(/\.md$/i, '') === wanted)
  if (byPath) return byPath
  const byTitle = all.filter((entry) => entry.title.toLowerCase() === wanted)
  return byTitle.length
    ? ([...byTitle].sort((a, b) => a.path.length - b.path.length)[0] ?? null)
    : null
}
