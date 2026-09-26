#!/usr/bin/env node
/**
 * Repository secret scan.
 *
 *   node scripts/check-secrets.mjs [root] [--include-build]
 *
 * Scans every file git tracks plus untracked files that are not ignored
 * (so a new file is checked before it is committed), and optionally the build
 * output. Uses the same credential patterns as runtime log redaction
 * (packages/security/src/secret-patterns.ts, loaded with Node type stripping).
 *
 * Exit codes: 0 clean, 1 findings, 2 the scan itself could not run.
 * Findings never print the secret, only a short masked preview.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const { findSecrets } = await import(
  pathToFileURL(join(here, '../packages/security/src/secret-patterns.ts')).href
)

const args = process.argv.slice(2)
const root = resolve(args.find((arg) => !arg.startsWith('--')) ?? join(here, '..'))
const includeBuild = args.includes('--include-build')

const BINARY =
  /\.(png|jpe?g|gif|ico|icns|woff2?|ttf|otf|eot|zip|gz|7z|exe|dll|so|dylib|node|asar|pak|bin|dat|pdf)$/i
const MAX_BYTES = 5 * 1024 * 1024

function gitFiles() {
  try {
    const output = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
      }
    )
    return output.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

function walk(directory, base = directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(full, base))
    else if (entry.isFile()) files.push(relative(base, full))
  }
  return files
}

let files = gitFiles() ?? walk(root)
if (includeBuild) {
  for (const dir of ['apps/desktop/out']) {
    const full = join(root, dir)
    if (existsSync(full)) files.push(...walk(full).map((file) => join(dir, file)))
  }
}
files = [...new Set(files)].sort()

const findings = []
let scanned = 0
for (const file of files) {
  const full = join(root, file)
  if (BINARY.test(file) || !existsSync(full)) continue
  const stat = statSync(full)
  if (!stat.isFile() || stat.size > MAX_BYTES) continue
  if (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith('.env.example')) {
    findings.push({
      file,
      line: 1,
      column: 1,
      patternId: 'env-file',
      preview: 'environment file must not be committed'
    })
  }
  const text = readFileSync(full, 'utf8')
  scanned++
  for (const finding of findSecrets(text)) findings.push({ file, ...finding })
}

if (findings.length > 0) {
  console.error(`Secret scan: ${findings.length} finding(s) in ${scanned} file(s):`)
  for (const finding of findings) {
    console.error(
      `  ${finding.file}:${finding.line}:${finding.column}  ${finding.patternId}  ${finding.preview}`
    )
  }
  process.exit(1)
}
console.log(`Secret scan: no credentials found in ${scanned} file(s).`)
