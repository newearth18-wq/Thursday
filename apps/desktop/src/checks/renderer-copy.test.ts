import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * SET 2: "do not hardcode UI copy inside components". Every visible string
 * must come from the message catalogs, so this scans each component for
 * literal text in JSX and in attributes a person reads or hears.
 */

const ROOT = join(import.meta.dirname, '..', 'renderer', 'src')
const READ_ALOUD = new Set(['aria-label', 'title', 'placeholder', 'alt', 'aria-description'])
/** Letters in any script (Latin, Thai, …); punctuation and symbols alone are allowed. */
const WORDS = /\p{L}/u

function componentFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return componentFiles(path)
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : []
  })
}

function literalCopy(file: string): string[] {
  return literalCopyIn(relative(ROOT, file), readFileSync(file, 'utf8'))
}

function literalCopyIn(name: string, text: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const findings: string[] = []
  const report = (node: ts.Node, text: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart())
    findings.push(`${name}:${String(line + 1)} "${text.trim()}"`)
  }
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && WORDS.test(node.text)) report(node, node.text)
    if (
      ts.isJsxAttribute(node) &&
      READ_ALOUD.has(node.name.getText(source)) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      WORDS.test(node.initializer.text)
    ) {
      report(node, node.initializer.text)
    }
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isStringLiteral(node.expression) &&
      WORDS.test(node.expression.text) &&
      ts.isJsxElement(node.parent)
    ) {
      report(node, node.expression.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

describe('interface copy', () => {
  it('comes from the message catalogs, never from literals in components', () => {
    const files = componentFiles(ROOT)
    expect(files.length).toBeGreaterThan(20)
    expect(files.flatMap(literalCopy)).toEqual([])
  })

  it('catches literal copy when it is there', () => {
    expect(
      literalCopyIn(
        'probe.tsx',
        '<p title="Hello" aria-label={label}>Welcome {"back"} {t("key")} · 42</p>'
      )
    ).toEqual(['probe.tsx:1 "Hello"', 'probe.tsx:1 "Welcome"', 'probe.tsx:1 "back"'])
  })
})
