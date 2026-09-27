import { strToU8, unzipSync, zipSync } from 'fflate'
import { LIMITS } from './protocol'
import { attr, childrenOf, parseXml, type XmlElement } from './xml'

/**
 * Office documents are ZIP packages of XML parts linked by relationships
 * (Open Packaging Conventions). This opens one as untrusted input — within
 * limits on entries, unpacked size and compression ratio (a zip bomb is
 * refused before it is unpacked) — and writes new ones.
 */

export class DocumentError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'DocumentError'
  }
}

export interface Relationship {
  readonly id: string
  readonly type: string
  /** The part it points to, as a package name; null for an external target. */
  readonly target: string | null
  readonly external: boolean
}

const decoder = new TextDecoder('utf-8', { fatal: false })

export class Package {
  private readonly xmlCache = new Map<string, XmlElement>()

  constructor(private readonly parts: Readonly<Record<string, Uint8Array>>) {}

  get names(): string[] {
    return Object.keys(this.parts)
  }

  has(name: string): boolean {
    return Object.hasOwn(this.parts, name)
  }

  bytes(name: string): Uint8Array | null {
    return Object.hasOwn(this.parts, name) ? (this.parts[name] ?? null) : null
  }

  text(name: string): string | null {
    const bytes = this.bytes(name)
    return bytes ? decoder.decode(bytes) : null
  }

  /** The part parsed as XML; null when there is no such part. Throws on invalid XML. */
  xml(name: string): XmlElement | null {
    const cached = this.xmlCache.get(name)
    if (cached) return cached
    const text = this.text(name)
    if (text === null) return null
    const parsed = parseXml(text)
    this.xmlCache.set(name, parsed)
    return parsed
  }

  /** The relationships of a part (`word/document.xml` → `word/_rels/document.xml.rels`). */
  relationships(part: string): Relationship[] {
    const slash = part.lastIndexOf('/')
    const folder = slash === -1 ? '' : part.slice(0, slash)
    const file = slash === -1 ? part : part.slice(slash + 1)
    const relsName = `${folder ? `${folder}/` : ''}_rels/${file}.rels`
    const rels = this.xml(relsName)
    if (!rels) return []
    return childrenOf(rels, 'Relationship').map((rel) => {
      const external = attr(rel, 'TargetMode') === 'External'
      const target = attr(rel, 'Target') ?? ''
      return {
        id: attr(rel, 'Id') ?? '',
        type: attr(rel, 'Type') ?? '',
        target: external ? null : resolvePartName(folder, target),
        external
      }
    })
  }

  relationshipsOfType(part: string, suffix: string): Relationship[] {
    return this.relationships(part).filter((rel) => rel.type.endsWith(suffix))
  }
}

/** A relationship target as a package part name (no leading slash). */
export function resolvePartName(folder: string, target: string): string {
  const segments = target.startsWith('/') ? [] : folder.split('/').filter(Boolean)
  for (const segment of target.replace(/^\//, '').split('/')) {
    if (segment === '..') segments.pop()
    else if (segment !== '.' && segment !== '') segments.push(segment)
  }
  return segments.join('/')
}

export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  )
}

export function openPackage(bytes: Uint8Array, format: string): Package {
  if (!isZip(bytes))
    throw new DocumentError(
      'DOCUMENT_INVALID',
      `The file is not a ${format.toUpperCase()} document: it is not a ZIP package.`
    )
  let entries = 0
  let unpacked = 0
  let parts: Record<string, Uint8Array>
  try {
    parts = unzipSync(bytes, {
      filter(file) {
        entries += 1
        unpacked += file.originalSize
        if (entries > LIMITS.entries)
          throw new DocumentError(
            'DOCUMENT_TOO_LARGE',
            `The package has more than ${String(LIMITS.entries)} parts.`
          )
        if (unpacked > LIMITS.unpackedBytes)
          throw new DocumentError('DOCUMENT_TOO_LARGE', 'The package unpacks to more than 300 MB.')
        if (unpacked > 1024 * 1024 && unpacked / bytes.length > LIMITS.compressionRatio)
          throw new DocumentError(
            'DOCUMENT_TOO_LARGE',
            'The package is compressed far beyond what a document is (a possible zip bomb); it was not unpacked.'
          )
        return true
      }
    })
  } catch (error) {
    if (error instanceof DocumentError) throw error
    throw new DocumentError(
      'DOCUMENT_INVALID',
      `The ${format.toUpperCase()} package is damaged: ${error instanceof Error ? error.message : String(error)}.`
    )
  }
  for (const name of Object.keys(parts))
    if (name.startsWith('/') || name.split('/').includes('..'))
      throw new DocumentError(
        'DOCUMENT_INVALID',
        'The package contains a part with an unsafe name.'
      )
  return new Package(parts)
}

/** A ZIP package from its parts ([Content_Types].xml first, as Office writes it). */
export function writePackage(parts: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const ordered: Record<string, Uint8Array> = {}
  const names = Object.keys(parts).sort((a, b) =>
    a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : 0
  )
  for (const name of names) {
    const part = parts[name]
    if (part === undefined) continue
    ordered[name] = typeof part === 'string' ? strToU8(part) : part
  }
  return zipSync(ordered, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') })
}

/** The content type declared for a part: its Override, else the Default for its extension. */
export function contentTypeOf(pkg: Package, part: string): string | null {
  const types = pkg.xml('[Content_Types].xml')
  if (!types) return null
  for (const override of childrenOf(types, 'Override'))
    if ((attr(override, 'PartName') ?? '').replace(/^\//, '') === part)
      return attr(override, 'ContentType')
  const extension = part.slice(part.lastIndexOf('.') + 1).toLowerCase()
  for (const fallback of childrenOf(types, 'Default'))
    if ((attr(fallback, 'Extension') ?? '').toLowerCase() === extension)
      return attr(fallback, 'ContentType')
  return null
}
