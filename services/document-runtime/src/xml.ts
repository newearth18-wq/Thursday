import { LIMITS } from './protocol'

/**
 * A small, strict XML parser for the parts of Office documents (SET 10).
 *
 * Documents are untrusted input, so it refuses what XML attacks rely on: a
 * DOCTYPE, entity declarations and any entity other than the five built-in
 * ones and character references (no external entities, no entity
 * expansion). Elements must nest properly and close; nesting is limited.
 * Names are matched by their local part (`w:t` and `a:t` are both `t`).
 */

export interface XmlElement {
  readonly name: string
  readonly local: string
  readonly attrs: Readonly<Record<string, string>>
  readonly children: readonly XmlNode[]
}
export type XmlNode = XmlElement | string

export class XmlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XmlError'
  }
}

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/
const ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const BUILT_IN: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'"
}

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&([^;&\s]{1,10});/g, (whole, entity: string) => {
    const known = BUILT_IN[entity]
    if (known !== undefined) return known
    const code = /^#x([0-9a-f]+)$/i.exec(entity)?.[1] ?? /^#(\d+)$/.exec(entity)?.[1]
    if (code !== undefined) {
      const value =
        entity.startsWith('#x') || entity.startsWith('#X') ? parseInt(code, 16) : Number(code)
      if (value > 0 && value <= 0x10ffff) return String.fromCodePoint(value)
    }
    throw new XmlError(`The XML uses an entity that is not allowed: ${whole.slice(0, 20)}`)
  })
}

function localOf(name: string): string {
  const colon = name.indexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}

interface Open {
  name: string
  local: string
  attrs: Record<string, string>
  children: XmlNode[]
}

export function parseXml(source: string): XmlElement {
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const stack: Open[] = []
  let root: XmlElement | null = null
  const addText = (raw: string) => {
    const top = stack.at(-1)
    if (!top) {
      if (raw.trim() !== '') throw new XmlError('The XML has text outside its root element.')
      return
    }
    top.children.push(decodeEntities(raw))
  }
  while (index < source.length) {
    const lt = source.indexOf('<', index)
    if (lt === -1) {
      addText(source.slice(index))
      break
    }
    if (lt > index) addText(source.slice(index, lt))
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2)
      if (end === -1) throw new XmlError('The XML has an unclosed processing instruction.')
      index = end + 2
      continue
    }
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      if (end === -1) throw new XmlError('The XML has an unclosed comment.')
      index = end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9)
      if (end === -1) throw new XmlError('The XML has an unclosed CDATA section.')
      const top = stack.at(-1)
      if (!top) throw new XmlError('The XML has a CDATA section outside its root element.')
      top.children.push(source.slice(lt + 9, end))
      index = end + 3
      continue
    }
    if (source.startsWith('<!', lt))
      throw new XmlError('The XML declares a DOCTYPE or entities, which are not allowed.')
    const gt = source.indexOf('>', lt + 1)
    if (gt === -1) throw new XmlError('The XML has an unclosed tag.')
    const body = source.slice(lt + 1, gt)
    index = gt + 1
    if (body.startsWith('/')) {
      const name = body.slice(1).trim()
      const top = stack.pop()
      if (top?.name !== name)
        throw new XmlError(`The XML closes <${name}> where <${top?.name ?? 'nothing'}> is open.`)
      const element: XmlElement = top
      const parent = stack.at(-1)
      if (parent) parent.children.push(element)
      else if (root) throw new XmlError('The XML has more than one root element.')
      else root = element
      continue
    }
    const selfClosing = body.endsWith('/')
    const inner = selfClosing ? body.slice(0, -1) : body
    const nameEnd = inner.search(/\s/)
    const name = nameEnd === -1 ? inner : inner.slice(0, nameEnd)
    if (!NAME.test(name))
      throw new XmlError(`The XML has an invalid element name "${name.slice(0, 40)}".`)
    const attrs: Record<string, string> = {}
    if (nameEnd !== -1) {
      const rest = inner.slice(nameEnd)
      ATTRIBUTE.lastIndex = 0
      for (let match = ATTRIBUTE.exec(rest); match; match = ATTRIBUTE.exec(rest)) {
        const key = match[1] ?? ''
        if (Object.hasOwn(attrs, key)) throw new XmlError(`The XML repeats the attribute "${key}".`)
        attrs[key] = decodeEntities(match[2] ?? match[3] ?? '')
      }
      if (rest.replace(ATTRIBUTE, '').trim() !== '')
        throw new XmlError(`The XML has a malformed attribute in <${name}>.`)
    }
    const element: Open = { name, local: localOf(name), attrs, children: [] }
    if (selfClosing) {
      const parent = stack.at(-1)
      if (parent) parent.children.push(element)
      else if (root) throw new XmlError('The XML has more than one root element.')
      else root = element
      continue
    }
    if (stack.length >= LIMITS.xmlDepth) throw new XmlError('The XML is nested too deeply.')
    if (!stack.length && root) throw new XmlError('The XML has more than one root element.')
    stack.push(element)
  }
  if (stack.length)
    throw new XmlError(`The XML ends before <${stack.at(-1)?.name ?? ''}> is closed.`)
  if (!root) throw new XmlError('The XML has no root element.')
  return root
}

export function isElement(node: XmlNode): node is XmlElement {
  return typeof node !== 'string'
}

/** Direct children with this local name. */
export function childrenOf(element: XmlElement, local: string): XmlElement[] {
  return element.children.filter(
    (node): node is XmlElement => isElement(node) && node.local === local
  )
}

export function childOf(element: XmlElement, local: string): XmlElement | null {
  return childrenOf(element, local)[0] ?? null
}

/** All descendants with this local name, in document order. */
export function descendants(element: XmlElement, local: string): XmlElement[] {
  const found: XmlElement[] = []
  const walk = (node: XmlElement) => {
    for (const child of node.children) {
      if (!isElement(child)) continue
      if (child.local === local) found.push(child)
      walk(child)
    }
  }
  walk(element)
  return found
}

/** All text inside an element (the text nodes of every descendant). */
export function textOf(element: XmlElement): string {
  let text = ''
  for (const child of element.children) text += isElement(child) ? textOf(child) : child
  return text
}

/** The value of an attribute by its local name (`r:id` and `id` differ by prefix only). */
export function attr(element: XmlElement, local: string): string | null {
  for (const [key, value] of Object.entries(element.attrs)) if (localOf(key) === local) return value
  return null
}

/** A relationship id (`r:id`, `r:embed`…): the prefixed attribute, never a plain `id`. */
export function relId(element: XmlElement, local = 'id'): string | null {
  for (const [key, value] of Object.entries(element.attrs))
    if (key.includes(':') && localOf(key) === local) return value
  return null
}

export function escapeXml(text: string): string {
  // Characters XML 1.0 does not allow are dropped (a document may not contain them).
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  )
}
