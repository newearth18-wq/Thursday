import { spawnSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Document fixtures and the independent Office check of the SET 10 tests.
 *
 * The fixtures were made by programs other than Jupiter (headless Chromium
 * for the PDF and PNG; python-docx, python-pptx and openpyxl for Office
 * files) — see `scripts/make-document-fixtures.*`. `checkOffice` opens a
 * file Jupiter wrote with those Python libraries, which follow the Office
 * Open XML standard, and returns what they found.
 */

const here = dirname(fileURLToPath(import.meta.url))
export const DOCUMENT_FIXTURES = join(here, '..', 'fixtures', 'documents')

export const FIXTURE_FILES = [
  'briefing.docx',
  'budget.xlsx',
  'chart.png',
  'notes.txt',
  'plan.md',
  'planet.json',
  'planets.csv',
  'report.pdf',
  'review.pptx'
] as const

export function documentFixture(name: (typeof FIXTURE_FILES)[number]): string {
  return join(DOCUMENT_FIXTURES, name)
}

/** Copies fixtures into a folder (the test's own copy; the originals are never touched). */
export function copyFixtures(
  folder: string,
  names: readonly (typeof FIXTURE_FILES)[number][] = FIXTURE_FILES
): void {
  for (const name of names) copyFileSync(documentFixture(name), join(folder, name))
}

const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

/** Opens the file with python-docx, python-pptx or openpyxl; throws if it does not open. */
export function checkOffice(path: string, kind: 'docx' | 'pptx' | 'xlsx'): unknown {
  const result = spawnSync(PYTHON, [join(here, '..', 'scripts', 'check-office.py'), path, kind], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    timeout: 60_000
  })
  if (result.error) throw new Error(`Could not run ${PYTHON}: ${result.error.message}`)
  if (result.status !== 0)
    throw new Error(
      `The independent ${kind.toUpperCase()} parser could not open ${path}:\n${result.stderr}`
    )
  return JSON.parse(result.stdout) as unknown
}

/** Reads a note with an independent parser (PyYAML): valid frontmatter, body and [[links]]; throws if invalid. */
export function checkMarkdown(path: string): {
  bom: boolean
  frontmatter: Record<string, unknown> | null
  body: string
  links: string[]
  crlf: boolean
} {
  const result = spawnSync(PYTHON, [join(here, '..', 'scripts', 'check-markdown.py'), path], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    timeout: 60_000
  })
  if (result.error) throw new Error(`Could not run ${PYTHON}: ${result.error.message}`)
  if (result.status !== 0)
    throw new Error(`The independent Markdown reader could not read ${path}:\n${result.stderr}`)
  return JSON.parse(result.stdout) as ReturnType<typeof checkMarkdown>
}
