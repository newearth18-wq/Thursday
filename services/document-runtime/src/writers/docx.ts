import type { DocumentBlock } from '@jupiter/contracts'
import { writePackage } from '../package'
import { escapeXml } from '../xml'
import {
  NS,
  TYPE,
  XML_HEADER,
  appProperties,
  contentTypes,
  coreProperties,
  packageRels,
  relationships
} from './common'

/**
 * A WordprocessingML document (SET 10): a title, headings, paragraphs,
 * bulleted lists (real numbering, not typed bullets) and tables, in styles
 * Word defines. Latin text uses Calibri; Thai and other complex scripts
 * use Leelawadee UI.
 */

const MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const STYLES = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'
const NUMBERING = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'
const SETTINGS = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'

function runs(text: string, rPr: string): string {
  return text
    .split('\n')
    .map(
      (line, index) =>
        `${index > 0 ? `<w:r>${rPr}<w:br/></w:r>` : ''}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`
    )
    .join('')
}

function paragraph(text: string, style: string | null, extra = '', rPr = ''): string {
  const pPr =
    style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>` : ''
  return `<w:p>${pPr}${runs(text, rPr)}</w:p>`
}

function table(rows: readonly (readonly string[])[]): string {
  const columns = Math.max(...rows.map((row) => row.length))
  const width = Math.floor(9026 / columns)
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${String(width)}"/>`).join('')
  const body = rows
    .map(
      (row, rowIndex) =>
        `<w:tr>${Array.from({ length: columns }, (_, column) => {
          const text = row[column] ?? ''
          return `<w:tc><w:tcPr><w:tcW w:w="${String(width)}" w:type="dxa"/></w:tcPr>${paragraph(text, null, '', rowIndex === 0 ? '<w:rPr><w:b/></w:rPr>' : '')}</w:tc>`
        }).join('')}</w:tr>`
    )
    .join('')
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`
}

function block(item: DocumentBlock): string {
  switch (item.type) {
    case 'heading':
      return paragraph(item.text, `Heading${String(item.level)}`)
    case 'paragraph':
      return paragraph(item.text, null)
    case 'bullet':
      return paragraph(
        item.text,
        'ListBullet',
        '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'
      )
    case 'table':
      return `${table(item.rows)}${paragraph('', null)}`
  }
}

const FONTS =
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Leelawadee UI"/>'

function heading(id: string, name: string, size: number, outline: number | null): string {
  return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="${outline === null ? '10' : '9'}"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/>${outline === null ? '' : `<w:outlineLvl w:val="${String(outline)}"/>`}</w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="${String(size)}"/><w:szCs w:val="${String(size)}"/></w:rPr></w:style>`
}

const STYLES_XML = `${XML_HEADER}<w:styles xmlns:w="${NS.w}"><w:docDefaults><w:rPrDefault><w:rPr>${FONTS}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="th-TH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${heading('Title', 'Title', 56, null)}${heading('Heading1', 'heading 1', 32, 0)}${heading('Heading2', 'heading 2', 26, 1)}${heading('Heading3', 'heading 3', 24, 2)}<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:contextualSpacing/></w:pPr></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style></w:styles>`

const NUMBERING_XML = `${XML_HEADER}<w:numbering xmlns:w="${NS.w}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`

const SETTINGS_XML = `${XML_HEADER}<w:settings xmlns:w="${NS.w}"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`

export function writeDocx(
  spec: { title: string; author: string; blocks: readonly DocumentBlock[] },
  now: Date
): Uint8Array {
  const body = [paragraph(spec.title, 'Title'), ...spec.blocks.map(block)].join('')
  const document = `${XML_HEADER}<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
  return writePackage({
    '[Content_Types].xml': contentTypes({
      'word/document.xml': MAIN,
      'word/styles.xml': STYLES,
      'word/numbering.xml': NUMBERING,
      'word/settings.xml': SETTINGS,
      'docProps/core.xml': TYPE.core,
      'docProps/app.xml': TYPE.app
    }),
    '_rels/.rels': packageRels('word/document.xml'),
    'word/document.xml': document,
    'word/_rels/document.xml.rels': relationships([
      {
        id: 'rId1',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
        target: 'styles.xml'
      },
      {
        id: 'rId2',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
        target: 'numbering.xml'
      },
      {
        id: 'rId3',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
        target: 'settings.xml'
      }
    ]),
    'word/styles.xml': STYLES_XML,
    'word/numbering.xml': NUMBERING_XML,
    'word/settings.xml': SETTINGS_XML,
    'docProps/core.xml': coreProperties(spec.title, spec.author, now),
    'docProps/app.xml': appProperties()
  })
}
