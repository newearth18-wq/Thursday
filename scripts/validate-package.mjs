#!/usr/bin/env node
/**
 * Validate a packaged Jupiter build (SET 0 acceptance test 4).
 *
 *   node scripts/validate-package.mjs --platform win     # dist/win-unpacked (+ NSIS installer if present)
 *   node scripts/validate-package.mjs --platform linux   # dist/linux-unpacked
 *
 * Checks the real files electron-builder produced: the executable's binary
 * format and architecture, the embedded product name, the app.asar contents
 * (only the self-contained bundles, no sources, maps or node_modules), the
 * packaged version against build metadata, and a secret scan of everything
 * inside the archive. Writes an evidence report with SHA-256 hashes to
 * test-results/package-validation-<platform>.json.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractFile, listPackage } from '@electron/asar'

const root = fileURLToPath(new URL('..', import.meta.url))
const appDir = join(root, 'apps', 'desktop')
const { findSecrets } = await import(
  pathToFileURL(join(root, 'packages', 'security', 'src', 'secret-patterns.ts')).href
)

const platformArg = process.argv.indexOf('--platform')
const platform = platformArg > -1 ? process.argv[platformArg + 1] : 'win'
if (!['win', 'linux'].includes(platform)) {
  console.error(`Unknown --platform "${platform}" (expected win or linux)`)
  process.exit(2)
}

const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
const unpacked = join(appDir, 'dist', platform === 'win' ? 'win-unpacked' : 'linux-unpacked')
const executable = join(unpacked, platform === 'win' ? `${pkg.productName}.exe` : 'jupiter')
const asarPath = join(unpacked, 'resources', 'app.asar')
const results = []

/** @electron/asar splits lookup paths on path.sep, so archive paths must use native separators. */
function inArchive(entry) {
  return entry.replace(/^\//, '').split('/').join(sep)
}

function check(label, fn) {
  try {
    const detail = fn()
    results.push({ label, ok: true, detail: detail ?? '' })
  } catch (error) {
    results.push({
      label,
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function readHead(path, length) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, 0)
    return buffer
  } finally {
    closeSync(fd)
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function describePe(path) {
  const head = readHead(path, 4096)
  assert(head.toString('latin1', 0, 2) === 'MZ', 'missing MZ header: not a Windows executable')
  const peOffset = head.readUInt32LE(0x3c)
  assert(head.toString('latin1', peOffset, peOffset + 4) === 'PE\0\0', 'missing PE signature')
  const machine = head.readUInt16LE(peOffset + 4)
  assert(machine === 0x8664, `machine type 0x${machine.toString(16)} is not x64 (0x8664)`)
  const optional = peOffset + 24
  assert(head.readUInt16LE(optional) === 0x20b, 'not a PE32+ (64-bit) image')
  const subsystem = head.readUInt16LE(optional + 68)
  return {
    machine: 'x64',
    format: 'PE32+',
    subsystem: subsystem === 2 ? 'GUI' : `subsystem ${subsystem}`
  }
}

check('unpacked build directory exists', () => {
  assert(
    existsSync(unpacked),
    `${unpacked} does not exist — run "npm run package:${platform === 'win' ? 'windows:dir' : 'linux:dir'}" first`
  )
  return unpacked
})

check('executable is a valid binary for the target', () => {
  assert(existsSync(executable), `${executable} is missing`)
  if (platform === 'win') {
    const pe = describePe(executable)
    assert(pe.subsystem === 'GUI', `expected a GUI executable, found ${pe.subsystem}`)
    return `${pe.format} ${pe.machine} ${pe.subsystem}`
  }
  const head = readHead(executable, 20)
  assert(head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF', 'not an ELF executable')
  assert(head.readUInt16LE(18) === 0x3e, 'not an x86-64 ELF executable')
  return 'ELF x86-64'
})

if (platform === 'win') {
  check('executable carries the Jupiter product name and version', () => {
    const binary = readFileSync(executable)
    assert(
      binary.includes(Buffer.from(pkg.productName, 'utf16le')),
      'product name not found in version resources'
    )
    const numeric = pkg.version.split('-')[0]
    assert(
      binary.includes(Buffer.from(numeric, 'utf16le')),
      `version ${numeric} not found in version resources`
    )
    return `${pkg.productName} ${numeric}`
  })
}

let entries = []
check('app.asar contains only the self-contained bundles', () => {
  assert(existsSync(asarPath), `${asarPath} is missing`)
  entries = listPackage(asarPath, { isPack: false }).map((entry) => entry.replaceAll('\\', '/'))
  for (const required of [
    '/package.json',
    '/out/main/index.js',
    '/out/main/core.js',
    '/out/preload/index.cjs',
    '/out/renderer/index.html'
  ]) {
    assert(entries.includes(required), `${required} is missing from app.asar`)
  }
  const forbidden = entries.filter((entry) =>
    /node_modules|\.map$|\.tsx?$|\/src\/|\.env/.test(entry)
  )
  assert(
    forbidden.length === 0,
    `unexpected files in app.asar: ${forbidden.slice(0, 5).join(', ')}`
  )
  return `${entries.length} entries`
})

check('packaged version matches the source and the build metadata', () => {
  const packaged = JSON.parse(extractFile(asarPath, inArchive('package.json')).toString('utf8'))
  assert(packaged.version === pkg.version, `packaged version ${packaged.version} != ${pkg.version}`)
  assert(packaged.main === './out/main/index.js', `unexpected main entry ${packaged.main}`)
  const main = extractFile(asarPath, inArchive('out/main/index.js')).toString('utf8')
  const literal = /define_JUPITER_BUILD_METADATA_default = (\{[^;]*\});/.exec(main)?.[1]
  assert(literal, 'build metadata is not embedded in the main bundle')
  const metadata = JSON.parse(literal.replace(/([{,]\s*)(\w+):/g, '$1"$2":'))
  assert(metadata.version === pkg.version, `metadata version ${metadata.version} != ${pkg.version}`)
  return `${pkg.version} (${metadata.channel}, ${metadata.buildId})`
})

check('no credentials inside the packaged application', () => {
  let scanned = 0
  const findings = []
  for (const entry of entries) {
    if (!/\.(js|cjs|mjs|json|html|css|txt)$/.test(entry)) continue
    const text = extractFile(asarPath, inArchive(entry)).toString('utf8')
    scanned++
    for (const finding of findSecrets(text))
      findings.push(`${entry}:${finding.line} ${finding.patternId}`)
  }
  assert(findings.length === 0, `findings: ${findings.join('; ')}`)
  return `${scanned} text files scanned`
})

const installers =
  platform === 'win'
    ? readdirSync(join(appDir, 'dist')).filter((file) => /^Jupiter-Setup-.*\.exe$/.test(file))
    : []
for (const installer of installers) {
  check(`NSIS installer ${installer} is a valid Windows executable`, () => {
    const path = join(appDir, 'dist', installer)
    const head = readHead(path, 2)
    assert(head.toString('latin1') === 'MZ', 'installer is not a Windows executable')
    const size = statSync(path).size
    assert(size > 50 * 1024 * 1024, `installer is suspiciously small (${size} bytes)`)
    return `${(size / 1024 / 1024).toFixed(1)} MB`
  })
}

const evidence = {
  platform,
  version: pkg.version,
  validatedAt: new Date().toISOString(),
  artifacts: Object.fromEntries(
    [executable, asarPath, ...installers.map((file) => join(appDir, 'dist', file))]
      .filter((path) => existsSync(path))
      .map((path) => [
        path.slice(root.length),
        { bytes: statSync(path).size, sha256: sha256(path) }
      ])
  ),
  checks: results
}
mkdirSync(join(root, 'test-results'), { recursive: true })
const reportPath = join(root, 'test-results', `package-validation-${platform}.json`)
writeFileSync(reportPath, `${JSON.stringify(evidence, null, 2)}\n`)

for (const result of results)
  console.log(
    `  ${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.detail ? ` — ${result.detail}` : ''}`
  )
if (installers.length === 0 && platform === 'win') {
  console.log('  NOTE  no NSIS installer in dist/ — this validates the unpacked Windows build only')
}
console.log(`Evidence: ${reportPath}`)
process.exit(results.every((result) => result.ok) ? 0 : 1)
