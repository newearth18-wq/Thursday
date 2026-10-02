#!/usr/bin/env node
// Writes the SHA-256 of every file of a plugin folder into its manifest.json (SET 15).
//   node scripts/plugin-integrity.mjs plugins/demo-tools
// Jupiter checks these at install, at every load and for every update, and refuses a plugin
// whose files are missing, changed or not listed.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const folder = process.argv[2]
if (!folder) {
  console.error('Usage: node scripts/plugin-integrity.mjs <plugin folder>')
  process.exit(2)
}
const files = {}
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.isFile()) {
      const name = relative(folder, path).split(sep).join('/')
      if (name !== 'manifest.json')
        files[name] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
}
walk(folder)
const manifestPath = join(folder, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.integrity = { algorithm: 'sha256', files }
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`${manifestPath}: ${String(Object.keys(files).length)} files`)
