import { escapeXml } from '../xml'

/**
 * Pieces every Office package needs (SET 10): content types, the package
 * relationships and the document properties.
 */

export const NS = {
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  types: 'http://schemas.openxmlformats.org/package/2006/content-types',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  officeDocument:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  coreProperties:
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extendedProperties:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  x: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
} as const

export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

export const TYPE = {
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
  xml: 'application/xml',
  png: 'image/png',
  jpeg: 'image/jpeg',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml'
} as const

export interface Rel {
  readonly id: string
  readonly type: string
  readonly target: string
}

export function relationships(rels: readonly Rel[]): string {
  return `${XML_HEADER}<Relationships xmlns="${NS.rels}">${rels
    .map(
      (rel) => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${escapeXml(rel.target)}"/>`
    )
    .join('')}</Relationships>`
}

export function contentTypes(
  overrides: Readonly<Record<string, string>>,
  extraDefaults: Readonly<Record<string, string>> = {}
): string {
  const defaults: Record<string, string> = { rels: TYPE.rels, xml: TYPE.xml, ...extraDefaults }
  return `${XML_HEADER}<Types xmlns="${NS.types}">${Object.entries(defaults)
    .map(([extension, type]) => `<Default Extension="${extension}" ContentType="${type}"/>`)
    .join('')}${Object.entries(overrides)
    .map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`)
    .join('')}</Types>`
}

/** The package relationships: the main part and the document properties. */
export function packageRels(main: string): string {
  return relationships([
    { id: 'rId1', type: NS.officeDocument, target: main },
    { id: 'rId2', type: NS.coreProperties, target: 'docProps/core.xml' },
    { id: 'rId3', type: NS.extendedProperties, target: 'docProps/app.xml' }
  ])
}

export function coreProperties(title: string, author: string, now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  return `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(title)}</dc:title><dc:creator>${escapeXml(author || 'Jupiter')}</dc:creator><cp:lastModifiedBy>Jupiter</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`
}

export function appProperties(extra = ''): string {
  return `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Jupiter</Application>${extra}</Properties>`
}
