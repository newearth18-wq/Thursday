import type { SlideSpec } from '@jupiter/contracts'
import { DocumentError, writePackage } from '../package'
import { escapeXml } from '../xml'
import {
  NS,
  TYPE,
  XML_HEADER,
  appProperties,
  contentTypes,
  coreProperties,
  packageRels,
  relationships,
  type Rel
} from './common'

/**
 * A PresentationML deck (SET 10), 16:9: a theme (the accent colour and the
 * font chosen), one slide master with two layouts — Title, and Title and
 * Content — slides built on those layouts' placeholders, images scaled to
 * fit their area by their real pixel size, and speaker notes on a notes
 * page per slide.
 */

const T = {
  presentation:
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  layout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  master: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  notesMaster: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
  notesSlide: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  presProps: 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
  viewProps: 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
  tableStyles: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml'
} as const

const R = (name: string) =>
  `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${name}`

const SLIDE_W = 12_192_000
const SLIDE_H = 6_858_000

export interface SlideImage {
  readonly bytes: Uint8Array
}

/** The pixel size and type of a PNG or JPEG, from its header. */
export function imageInfo(bytes: Uint8Array): {
  width: number
  height: number
  type: 'png' | 'jpeg'
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length > 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452)
    return { width: view.getUint32(16), height: view.getUint32(20), type: 'png' }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break
      const marker = bytes[offset + 1] ?? 0
      const length = view.getUint16(offset + 2)
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
      if (isFrame)
        return {
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
          type: 'jpeg'
        }
      offset += 2 + length
    }
  }
  throw new DocumentError('IMAGE_INVALID', 'The image is not a PNG or JPEG file.')
}

function paragraphs(lines: readonly string[], bullet: boolean): string {
  if (!lines.length) return '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>'
  return lines
    .map(
      (line) =>
        `<a:p>${bullet ? '' : '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>'}<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>`
    )
    .join('')
}

function placeholder(
  id: number,
  name: string,
  ph: string,
  text: string,
  box: readonly [number, number, number, number] | null
): string {
  const xfrm = box
    ? `<a:xfrm><a:off x="${String(box[0])}" y="${String(box[1])}"/><a:ext cx="${String(box[2])}" cy="${String(box[3])}"/></a:xfrm>`
    : ''
  return `<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="${escapeXml(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${text}</p:txBody></p:sp>`
}

const GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
const HEAD = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"`
const CLR_MAP =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"'

const BOXES = {
  ctrTitle: [1_524_000, 1_122_363, 9_144_000, 2_387_600],
  subTitle: [1_524_000, 3_602_038, 9_144_000, 1_655_762],
  title: [838_200, 365_125, 10_515_600, 1_325_563],
  body: [838_200, 1_825_625, 10_515_600, 4_351_338],
  half: [838_200, 1_825_625, 5_181_600, 4_351_338],
  picture: [6_172_200, 1_825_625, 5_181_600, 4_351_338]
} as const

function theme(name: string, accent: string, font: string): string {
  const fill = (inner: string) => `<a:solidFill>${inner}</a:solidFill>`
  const phClr = '<a:schemeClr val="phClr"/>'
  return `${XML_HEADER}<a:theme xmlns:a="${NS.a}" name="${escapeXml(name)}"><a:themeElements><a:clrScheme name="Jupiter"><a:dk1><a:srgbClr val="1B1B1F"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2A44"/></a:dk2><a:lt2><a:srgbClr val="EEF1F6"/></a:lt2><a:accent1><a:srgbClr val="${accent.toUpperCase()}"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Jupiter"><a:majorFont><a:latin typeface="${escapeXml(font)}"/><a:ea typeface=""/><a:cs typeface="Leelawadee UI"/></a:majorFont><a:minorFont><a:latin typeface="${escapeXml(font)}"/><a:ea typeface=""/><a:cs typeface="Leelawadee UI"/></a:minorFont></a:fontScheme><a:fmtScheme name="Jupiter"><a:fillStyleLst>${fill(phClr)}${fill('<a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr>')}${fill('<a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr>')}</a:fillStyleLst><a:lnStyleLst><a:ln w="6350">${fill(phClr)}</a:ln><a:ln w="12700">${fill(phClr)}</a:ln><a:ln w="19050">${fill(phClr)}</a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fill(phClr)}${fill('<a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr>')}${fill('<a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr>')}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
}

function level(n: number, size: number, bullet: boolean): string {
  const indent = bullet ? ` marL="${String(228_600 + n * 457_200)}" indent="-228600"` : ''
  const bu = bullet ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : '<a:buNone/>'
  return `<a:lvl${String(n + 1)}pPr${indent} algn="l" defTabSz="914400"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="1000"/></a:spcBef>${bu}<a:defRPr sz="${String(size)}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${String(n + 1)}pPr>`
}

function master(): string {
  const title = placeholder(
    2,
    'Title Placeholder 1',
    '<p:ph type="title"/>',
    paragraphs(['Title'], false),
    BOXES.title
  )
  const body = placeholder(
    3,
    'Text Placeholder 2',
    '<p:ph type="body" idx="1"/>',
    paragraphs(['Text'], true),
    BOXES.body
  )
  return `${XML_HEADER}<p:sldMaster ${HEAD}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}${title}${body}</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" b="1" kern="1200"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${level(0, 2800, true)}${level(1, 2400, true)}</p:bodyStyle><p:otherStyle>${level(0, 1800, false)}</p:otherStyle></p:txStyles></p:sldMaster>`
}

function layout(type: 'title' | 'obj', name: string): string {
  const shapes =
    type === 'title'
      ? placeholder(
          2,
          'Title 1',
          '<p:ph type="ctrTitle"/>',
          paragraphs(['Title'], false),
          BOXES.ctrTitle
        ) +
        placeholder(
          3,
          'Subtitle 2',
          '<p:ph type="subTitle" idx="1"/>',
          paragraphs(['Subtitle'], false),
          BOXES.subTitle
        )
      : placeholder(2, 'Title 1', '<p:ph type="title"/>', paragraphs(['Title'], false), null) +
        placeholder(3, 'Content Placeholder 2', '<p:ph idx="1"/>', paragraphs(['Text'], true), null)
  return `${XML_HEADER}<p:sldLayout ${HEAD} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
}

function notesMaster(): string {
  const image = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:sp>`
  const body = placeholder(
    3,
    'Notes Placeholder 2',
    '<p:ph type="body" sz="quarter" idx="3"/>',
    paragraphs(['Notes'], false),
    [685_800, 4_400_550, 5_486_400, 3_600_450]
  )
  return `${XML_HEADER}<p:notesMaster ${HEAD}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}${image}${body}</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:notesStyle>${level(0, 1200, false)}</p:notesStyle></p:notesMaster>`
}

function notesSlide(notes: string): string {
  const image = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>`
  const body = placeholder(
    3,
    'Notes Placeholder 2',
    '<p:ph type="body" idx="1"/>',
    paragraphs(notes.split('\n'), false),
    null
  )
  return `${XML_HEADER}<p:notes ${HEAD}><p:cSld><p:spTree>${GROUP}${image}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`
}

function picture(
  id: number,
  alt: string,
  relId: string,
  info: { width: number; height: number },
  area: readonly [number, number, number, number]
): string {
  const scale = Math.min(area[2] / info.width, area[3] / info.height)
  const cx = Math.round(info.width * scale)
  const cy = Math.round(info.height * scale)
  const x = area[0] + Math.round((area[2] - cx) / 2)
  const y = area[1] + Math.round((area[3] - cy) / 2)
  return `<p:pic><p:nvPicPr><p:cNvPr id="${String(id)}" name="Picture ${String(id)}" descr="${escapeXml(alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${String(x)}" y="${String(y)}"/><a:ext cx="${String(cx)}" cy="${String(cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
}

function slideXml(
  slide: SlideSpec,
  imageRel: string | null,
  info: { width: number; height: number } | null
): string {
  let shapes: string
  if (slide.layout === 'title') {
    shapes =
      placeholder(2, 'Title 1', '<p:ph type="ctrTitle"/>', paragraphs([slide.title], false), null) +
      placeholder(
        3,
        'Subtitle 2',
        '<p:ph type="subTitle" idx="1"/>',
        paragraphs(slide.subtitle ? slide.subtitle.split('\n') : [], false),
        null
      )
    if (imageRel && info)
      shapes += picture(4, slide.image?.alt ?? '', imageRel, info, [
        BOXES.subTitle[0],
        BOXES.subTitle[1] + BOXES.subTitle[3],
        BOXES.subTitle[2],
        SLIDE_H - BOXES.subTitle[1] - BOXES.subTitle[3] - 228_600
      ])
  } else {
    const lines = slide.bullets.length
      ? slide.bullets
      : slide.subtitle
        ? slide.subtitle.split('\n')
        : []
    shapes =
      placeholder(2, 'Title 1', '<p:ph type="title"/>', paragraphs([slide.title], false), null) +
      placeholder(
        3,
        'Content Placeholder 2',
        '<p:ph idx="1"/>',
        paragraphs(lines, slide.bullets.length > 0),
        imageRel ? BOXES.half : null
      )
    if (imageRel && info)
      shapes += picture(4, slide.image?.alt ?? '', imageRel, info, BOXES.picture)
  }
  return `${XML_HEADER}<p:sld ${HEAD}><p:cSld><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

export function writePptx(
  spec: {
    title: string
    author: string
    theme: { accent: string; font: string }
    slides: readonly SlideSpec[]
  },
  images: ReadonlyMap<number, Uint8Array>,
  now: Date
): Uint8Array {
  const parts: Record<string, string | Uint8Array> = {}
  const overrides: Record<string, string> = {
    'ppt/presentation.xml': T.presentation,
    'ppt/slideMasters/slideMaster1.xml': T.master,
    'ppt/slideLayouts/slideLayout1.xml': T.layout,
    'ppt/slideLayouts/slideLayout2.xml': T.layout,
    'ppt/notesMasters/notesMaster1.xml': T.notesMaster,
    'ppt/theme/theme1.xml': T.theme,
    'ppt/theme/theme2.xml': T.theme,
    'ppt/presProps.xml': T.presProps,
    'ppt/viewProps.xml': T.viewProps,
    'ppt/tableStyles.xml': T.tableStyles,
    'docProps/core.xml': TYPE.core,
    'docProps/app.xml': TYPE.app
  }
  const presentationRels: Rel[] = [
    { id: 'rId1', type: R('slideMaster'), target: 'slideMasters/slideMaster1.xml' }
  ]
  const slideIds: string[] = []
  let hasPng = false
  let hasJpeg = false
  for (const [index, slide] of spec.slides.entries()) {
    const n = String(index + 1)
    const slideRels: Rel[] = [
      {
        id: 'rId1',
        type: R('slideLayout'),
        target: `../slideLayouts/slideLayout${slide.layout === 'title' ? '1' : '2'}.xml`
      },
      { id: 'rId2', type: R('notesSlide'), target: `../notesSlides/notesSlide${n}.xml` }
    ]
    let imageRel: string | null = null
    let info: { width: number; height: number } | null = null
    const bytes = images.get(index)
    if (slide.image) {
      if (!bytes)
        throw new DocumentError('IMAGE_INVALID', `The image for slide ${n} was not provided.`)
      const found = imageInfo(bytes)
      info = found
      const media = `image${n}.${found.type === 'png' ? 'png' : 'jpeg'}`
      if (found.type === 'png') hasPng = true
      else hasJpeg = true
      parts[`ppt/media/${media}`] = bytes
      imageRel = 'rId3'
      slideRels.push({ id: 'rId3', type: R('image'), target: `../media/${media}` })
    }
    parts[`ppt/slides/slide${n}.xml`] = slideXml(slide, imageRel, info)
    parts[`ppt/slides/_rels/slide${n}.xml.rels`] = relationships(slideRels)
    parts[`ppt/notesSlides/notesSlide${n}.xml`] = notesSlide(slide.notes)
    parts[`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`] = relationships([
      { id: 'rId1', type: R('notesMaster'), target: '../notesMasters/notesMaster1.xml' },
      { id: 'rId2', type: R('slide'), target: `../slides/slide${n}.xml` }
    ])
    overrides[`ppt/slides/slide${n}.xml`] = T.slide
    overrides[`ppt/notesSlides/notesSlide${n}.xml`] = T.notesSlide
    const relId = `rId${String(index + 2)}`
    presentationRels.push({ id: relId, type: R('slide'), target: `slides/slide${n}.xml` })
    slideIds.push(`<p:sldId id="${String(256 + index)}" r:id="${relId}"/>`)
  }
  const next = presentationRels.length + 1
  presentationRels.push(
    { id: `rId${String(next)}`, type: R('notesMaster'), target: 'notesMasters/notesMaster1.xml' },
    { id: `rId${String(next + 1)}`, type: R('theme'), target: 'theme/theme1.xml' },
    { id: `rId${String(next + 2)}`, type: R('presProps'), target: 'presProps.xml' },
    { id: `rId${String(next + 3)}`, type: R('viewProps'), target: 'viewProps.xml' },
    { id: `rId${String(next + 4)}`, type: R('tableStyles'), target: 'tableStyles.xml' }
  )
  const presentation = `${XML_HEADER}<p:presentation ${HEAD} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId${String(next)}"/></p:notesMasterIdLst><p:sldIdLst>${slideIds.join('')}</p:sldIdLst><p:sldSz cx="${String(SLIDE_W)}" cy="${String(SLIDE_H)}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle>${level(0, 1800, false)}</p:defaultTextStyle></p:presentation>`
  const defaults: Record<string, string> = {}
  if (hasPng) defaults.png = TYPE.png
  if (hasJpeg) defaults.jpeg = TYPE.jpeg
  return writePackage({
    '[Content_Types].xml': contentTypes(overrides, defaults),
    '_rels/.rels': packageRels('ppt/presentation.xml'),
    'ppt/presentation.xml': presentation,
    'ppt/_rels/presentation.xml.rels': relationships(presentationRels),
    'ppt/slideMasters/slideMaster1.xml': master(),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': relationships([
      { id: 'rId1', type: R('slideLayout'), target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: R('slideLayout'), target: '../slideLayouts/slideLayout2.xml' },
      { id: 'rId3', type: R('theme'), target: '../theme/theme1.xml' }
    ]),
    'ppt/slideLayouts/slideLayout1.xml': layout('title', 'Title Slide'),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': relationships([
      { id: 'rId1', type: R('slideMaster'), target: '../slideMasters/slideMaster1.xml' }
    ]),
    'ppt/slideLayouts/slideLayout2.xml': layout('obj', 'Title and Content'),
    'ppt/slideLayouts/_rels/slideLayout2.xml.rels': relationships([
      { id: 'rId1', type: R('slideMaster'), target: '../slideMasters/slideMaster1.xml' }
    ]),
    'ppt/notesMasters/notesMaster1.xml': notesMaster(),
    'ppt/notesMasters/_rels/notesMaster1.xml.rels': relationships([
      { id: 'rId1', type: R('theme'), target: '../theme/theme2.xml' }
    ]),
    'ppt/theme/theme1.xml': theme('Jupiter', spec.theme.accent, spec.theme.font),
    'ppt/theme/theme2.xml': theme('Jupiter Notes', spec.theme.accent, spec.theme.font),
    'ppt/presProps.xml': `${XML_HEADER}<p:presentationPr ${HEAD}/>`,
    'ppt/viewProps.xml': `${XML_HEADER}<p:viewPr ${HEAD}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
    'ppt/tableStyles.xml': `${XML_HEADER}<a:tblStyleLst xmlns:a="${NS.a}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    ...parts,
    'docProps/core.xml': coreProperties(spec.title, spec.author, now),
    'docProps/app.xml': appProperties(
      `<Slides>${String(spec.slides.length)}</Slides><Notes>${String(spec.slides.length)}</Notes>`
    )
  })
}
