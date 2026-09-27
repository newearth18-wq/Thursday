import type { NoteEntry } from '@jupiter/contracts'
import { describe, expect, it } from 'vitest'
import {
  addLink,
  appendSection,
  buildNote,
  linkTextFor,
  linksIn,
  parseNote,
  resolveLink
} from './markdown'

const entry = (path: string): NoteEntry => ({
  path,
  title: (path.split('/').pop() ?? path).replace(/\.md$/, ''),
  folder: path.split('/').slice(0, -1).join('/'),
  size: 1,
  modifiedAt: '2026-09-27T00:00:00.000Z'
})

describe('Markdown notes', () => {
  it('builds a note with quoted YAML frontmatter, a title, the body and its links', () => {
    const text = buildNote({
      title: 'Plan: "phase 2"',
      body: 'Line one\r\nLine two',
      tags: ['work'],
      links: ['Jupiter'],
      created: '2026-09-27T10:00:00.000Z'
    })
    expect(text).toBe(
      [
        '---',
        'title: "Plan: \\"phase 2\\""',
        'created: "2026-09-27T10:00:00.000Z"',
        'source: "Jupiter"',
        'tags:',
        '  - "jupiter"',
        '  - "work"',
        '---',
        '',
        '# Plan: "phase 2"',
        '',
        'Line one',
        'Line two',
        '',
        '## Links',
        '',
        '- [[Jupiter]]',
        ''
      ].join('\n')
    )
  })

  it('parses frontmatter, tags and links without changing anything', () => {
    const note = parseNote({
      entry: entry('A.md'),
      text: '---\r\ntags: [space, planets]\r\nrating: 5\r\n---\r\nBody #moon [[B]] and [[C|see C]] and [[B#Heading]]\r\n',
      bom: false,
      eol: '\r\n',
      hash: 'a'.repeat(64)
    })
    expect(note.properties).toEqual({ tags: ['space', 'planets'], rating: '5' })
    expect(note.tags).toEqual(['space', 'planets', 'moon'])
    expect(note.links).toEqual(['B', 'C'])
    expect(note.frontmatter).toBe('tags: [space, planets]\r\nrating: 5')
  })

  it('appends a section after everything that was there, byte for byte', () => {
    expect(appendSection('# A\n\nText', 'New', 'More', '\n')).toBe(
      '# A\n\nText\n\n## New\n\nMore\n'
    )
    expect(appendSection('# A\r\n', null, 'More', '\r\n')).toBe('# A\r\n\r\nMore\r\n')
    expect(appendSection('# A\n\n', 'New', 'x', '\n')).toBe('# A\n\n## New\n\nx\n')
  })

  it('adds a link once, into its section, keeping every other line and its own line ending', () => {
    const mixed = '# A\r\n\r\n## Backlinks\n\n- [[B]]\r\n\r\n## Next\n'
    const once = addLink(mixed, 'Backlinks', 'C', '\n')
    expect(once).toEqual({
      text: '# A\r\n\r\n## Backlinks\n\n- [[B]]\r\n- [[C]]\n\r\n## Next\n',
      added: true
    })
    expect(addLink(once.text, 'Backlinks', 'c', '\n')).toEqual({ text: once.text, added: false })
    expect(addLink('# A', 'Links', 'B', '\n').text).toBe('# A\n\n## Links\n\n- [[B]]\n')
    expect(linksIn(once.text)).toEqual(['B', 'C'])
  })

  it('resolves links the way Obsidian does, and uses a path when a title is not unique', () => {
    const all = [entry('Space/Jupiter.md'), entry('Jupiter.md'), entry('Moons/Io.md')]
    expect(resolveLink('io', all)?.path).toBe('Moons/Io.md')
    expect(resolveLink('Space/Jupiter', all)?.path).toBe('Space/Jupiter.md')
    expect(resolveLink('Jupiter', all)?.path).toBe('Jupiter.md')
    expect(resolveLink('Pluto', all)).toBeNull()
    expect(linkTextFor(entry('Space/Jupiter.md'), all)).toBe('Space/Jupiter')
    expect(linkTextFor(entry('Moons/Io.md'), all)).toBe('Io')
  })
})
