import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import {
  MAX_IMAGE_BYTES,
  type CapturedWindow,
  type HostCaptureInput,
  type HostImage,
  type HostOcrResult,
  type HostQrResult,
  type HostVisionEngines,
  type PixelBox,
  type TextLine,
  type VisionEngineInfo
} from '@jupiter/contracts'
import { JupiterError, type Logger } from '@jupiter/core'
import {
  blackOut,
  changedFraction,
  crop,
  decodePng,
  encodePng,
  isPng,
  pngSize,
  PngError,
  type Bitmap
} from './png'

/**
 * The vision host (SET 13): what only the host may do with images.
 *
 * - Screen capture, through a `ScreenCapturer` the host owns: the whole
 *   screen, the active window, a region of the screen, or a window by the
 *   handle the Computer Agent found. What is captured is decided here, never
 *   by a path or a command in a request.
 * - OCR on this computer with Tesseract, which reports a confidence for every
 *   word (Windows OCR does not, and a result without a confidence cannot be
 *   used as evidence). QR codes with zbar where it is installed.
 * - Blacking out regions and comparing two captures, on pixels in memory.
 *
 * Images reach the engines only on standard input, and results come back on
 * standard output: nothing is written to disk.
 */

const TIMEOUT_MS = 60_000
const MAX_OUTPUT = 8 * 1024 * 1024
/** The languages Jupiter reads, when the engine has them. */
const OCR_LANGUAGES = ['eng', 'tha'] as const

export interface CapturedScreen {
  readonly png: Buffer
  readonly window: CapturedWindow | null
}

/** Captures pixels from the screen. The Electron implementation is in `screen-capture.ts`. */
export interface ScreenCapturer {
  readonly name: string
  /** Why a kind of capture cannot be made here, or null when it can. */
  unavailable(source: 'desktop' | 'active-window' | 'window'): string | null
  desktop(): Promise<CapturedScreen>
  activeWindow(): Promise<CapturedScreen>
  window(handle: number): Promise<CapturedScreen>
}

export interface VisionHostOptions {
  readonly logger: Logger
  readonly capturer: ScreenCapturer | null
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
}

interface Tool {
  readonly path: string
  readonly version: string
}

export class VisionHost {
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private tools: Promise<{
    tesseract: (Tool & { languages: string[] }) | null
    zbar: Tool | null
  }> | null = null

  constructor(private readonly options: VisionHostOptions) {
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
  }

  async engines(): Promise<HostVisionEngines> {
    const { tesseract, zbar } = await this.findTools()
    const capturer = this.options.capturer
    const unavailable = capturer
      ? capturer.unavailable('desktop')
      : 'This host cannot capture the screen.'
    const info = (
      kind: VisionEngineInfo['kind'],
      values: Partial<VisionEngineInfo>
    ): VisionEngineInfo => ({
      kind,
      available: false,
      reason: null,
      name: null,
      locality: 'this-device',
      languages: [],
      providerId: null,
      modelId: null,
      ...values
    })
    return {
      capture: info('capture', {
        available: capturer !== null && unavailable === null,
        reason: unavailable,
        name: capturer?.name ?? null
      }),
      ocr: tesseract
        ? info('ocr', {
            available: tesseract.languages.length > 0,
            reason: tesseract.languages.length
              ? null
              : 'Tesseract has no English or Thai language data.',
            name: `Tesseract ${tesseract.version}`,
            languages: tesseract.languages.map((code) => (code === 'tha' ? 'th' : 'en'))
          })
        : info('ocr', {
            reason:
              this.platform === 'win32'
                ? 'Not configured: install Tesseract OCR (for example "winget install UB-Mannheim.TesseractOCR") to read text on this computer.'
                : 'Not configured: install Tesseract OCR (for example "sudo apt install tesseract-ocr tesseract-ocr-tha") to read text on this computer.'
          }),
      qr: zbar
        ? info('qr', { available: true, name: `zbar ${zbar.version}` })
        : info('qr', {
            reason: 'Not configured: install zbar (zbarimg) to read QR codes on this computer.'
          }),
      camera: info('camera', { available: true, name: 'Chromium camera' })
    }
  }

  async capture(input: HostCaptureInput): Promise<HostImage> {
    const capturer = this.options.capturer
    if (!capturer)
      throw new JupiterError('CAPTURE_UNAVAILABLE', 'This host cannot capture the screen.', {
        category: 'unsupported',
        userAction: null
      })
    const source =
      input.source === 'region' ? 'desktop' : input.source === 'window' ? 'window' : input.source
    const reason = capturer.unavailable(source)
    if (reason)
      throw new JupiterError('CAPTURE_UNAVAILABLE', reason, {
        category: 'unsupported',
        userAction: null
      })
    let shot: CapturedScreen
    try {
      if (input.source === 'window') {
        if (input.handle === null)
          throw new JupiterError(
            'VALIDATION_FAILED',
            'A window capture needs the window’s handle.',
            {
              category: 'validation',
              userAction: null
            }
          )
        shot = await capturer.window(input.handle)
      } else if (input.source === 'active-window') shot = await capturer.activeWindow()
      else shot = await capturer.desktop()
    } catch (error) {
      if (error instanceof JupiterError) throw error
      throw new JupiterError(
        'CAPTURE_FAILED',
        `The screen could not be captured: ${messageOf(error)}`,
        {
          category: 'dependency',
          userAction:
            'Try again. If it keeps failing, check that the display is on and not locked.',
          retryable: true
        }
      )
    }
    let png = shot.png
    let region: PixelBox | null = null
    if (input.source === 'region') {
      if (!input.region)
        throw new JupiterError('VALIDATION_FAILED', 'A region capture needs a region.', {
          category: 'validation',
          userAction: null
        })
      const bitmap = this.decode(png)
      const area = crop(bitmap, input.region)
      region = { x: input.region.x, y: input.region.y, width: area.width, height: area.height }
      png = encodePng(area)
    }
    const size = pngSize(png)
    if (png.byteLength > MAX_IMAGE_BYTES)
      throw new JupiterError('IMAGE_TOO_LARGE', 'The capture is larger than 12 MB.', {
        category: 'validation',
        userAction: 'Capture a region or a single window instead.'
      })
    return {
      mediaType: 'image/png',
      data: png.toString('base64'),
      width: size.width,
      height: size.height,
      window: shot.window,
      region
    }
  }

  async ocr(image: { data: string }): Promise<HostOcrResult> {
    const { tesseract } = await this.findTools()
    if (!tesseract || tesseract.languages.length === 0)
      throw new JupiterError(
        'OCR_UNAVAILABLE',
        'Text cannot be read on this computer: Tesseract OCR is not installed (Not configured).',
        { category: 'dependency', userAction: 'Install Tesseract OCR, then try again.' }
      )
    const png = this.image(image.data)
    let output: Buffer
    try {
      output = await this.run(
        tesseract.path,
        ['stdin', 'stdout', '-l', tesseract.languages.join('+'), '--psm', '3', 'tsv'],
        png
      )
    } catch (error) {
      throw new JupiterError(
        'OCR_FAILED',
        `Tesseract could not read the image: ${messageOf(error)}`,
        {
          category: 'dependency',
          userAction: 'Try again with a clearer or larger image.',
          retryable: true
        }
      )
    }
    return {
      engine: `Tesseract ${tesseract.version}`,
      languages: tesseract.languages.map((code) => (code === 'tha' ? 'th' : 'en')),
      lines: parseTesseractTsv(output.toString('utf8'))
    }
  }

  async qr(image: { data: string }): Promise<HostQrResult> {
    const { zbar } = await this.findTools()
    if (!zbar)
      throw new JupiterError(
        'QR_UNAVAILABLE',
        'QR codes cannot be read on this computer: zbar is not installed (Not configured).',
        { category: 'dependency', userAction: 'Install zbar, then try again.' }
      )
    const png = this.image(image.data)
    let output: Buffer
    try {
      // zbarimg exits with 4 when the image has no code: that is an answer, not a failure.
      output = await this.run(zbar.path, ['-q', '--xml', '-'], png, [0, 4])
    } catch (error) {
      throw new JupiterError('QR_FAILED', `zbar could not read the image: ${messageOf(error)}`, {
        category: 'dependency',
        userAction: null,
        retryable: true
      })
    }
    return { engine: `zbar ${zbar.version}`, codes: parseZbarXml(output.toString('utf8')) }
  }

  redact(input: { data: string; boxes: readonly PixelBox[] }): {
    mediaType: 'image/png'
    data: string
  } {
    const bitmap = this.decode(this.image(input.data))
    return {
      mediaType: 'image/png',
      data: encodePng(blackOut(bitmap, input.boxes)).toString('base64')
    }
  }

  compare(input: { before: { data: string }; after: { data: string } }): {
    sameSize: boolean
    changedFraction: number | null
  } {
    const before = this.decode(this.image(input.before.data))
    const after = this.decode(this.image(input.after.data))
    const fraction = changedFraction(before, after)
    return { sameSize: fraction !== null, changedFraction: fraction }
  }

  // ---- internals ------------------------------------------------------------------------------

  private image(data: string): Buffer {
    const png = Buffer.from(data, 'base64')
    if (!isPng(png))
      throw new JupiterError('IMAGE_INVALID', 'The image is not a PNG.', {
        category: 'validation',
        userAction: null
      })
    if (png.byteLength > MAX_IMAGE_BYTES)
      throw new JupiterError('IMAGE_TOO_LARGE', 'The image is larger than 12 MB.', {
        category: 'validation',
        userAction: null
      })
    return png
  }

  private decode(png: Buffer): Bitmap {
    try {
      return decodePng(png)
    } catch (error) {
      throw new JupiterError(
        'IMAGE_INVALID',
        error instanceof PngError ? error.message : 'The image could not be read.',
        { category: 'validation', userAction: null }
      )
    }
  }

  private findTools(): Promise<{
    tesseract: (Tool & { languages: string[] }) | null
    zbar: Tool | null
  }> {
    this.tools ??= (async () => {
      const tesseractPath = this.findExecutable('tesseract', [
        join(this.env.ProgramFiles ?? 'C:\\Program Files', 'Tesseract-OCR'),
        join(this.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Tesseract-OCR')
      ])
      let tesseract: (Tool & { languages: string[] }) | null = null
      if (tesseractPath) {
        try {
          const version = /tesseract\s+v?([\d.]+)/i.exec(
            (await this.run(tesseractPath, ['--version'], Buffer.alloc(0))).toString('utf8')
          )?.[1]
          const listed = (await this.run(tesseractPath, ['--list-langs'], Buffer.alloc(0)))
            .toString('utf8')
            .split(/\r?\n/)
            .map((line) => line.trim())
          tesseract = {
            path: tesseractPath,
            version: version ?? 'unknown',
            languages: OCR_LANGUAGES.filter((code) => listed.includes(code))
          }
        } catch (error) {
          this.options.logger.warn(
            'vision.tesseract.unusable',
            'Tesseract is installed but did not run',
            {
              reason: messageOf(error)
            }
          )
        }
      }
      const zbarPath = this.findExecutable('zbarimg', [
        join(this.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'ZBar', 'bin'),
        join(this.env.ProgramFiles ?? 'C:\\Program Files', 'ZBar', 'bin')
      ])
      let zbar: Tool | null = null
      if (zbarPath) {
        try {
          const version = (await this.run(zbarPath, ['--version'], Buffer.alloc(0)))
            .toString('utf8')
            .trim()
          zbar = { path: zbarPath, version: /^[\d.]+$/.test(version) ? version : 'unknown' }
        } catch (error) {
          this.options.logger.warn('vision.zbar.unusable', 'zbar is installed but did not run', {
            reason: messageOf(error)
          })
        }
      }
      return { tesseract, zbar }
    })()
    return this.tools
  }

  private findExecutable(name: string, windowsFolders: readonly string[]): string | null {
    const file = this.platform === 'win32' ? `${name}.exe` : name
    const folders = [
      ...(this.env.PATH ?? this.env.Path ?? '').split(this.platform === 'win32' ? ';' : delimiter),
      ...(this.platform === 'win32' ? windowsFolders : [])
    ]
    for (const folder of folders) {
      if (!folder) continue
      const candidate = join(folder, file)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  private run(
    command: string,
    args: readonly string[],
    input: Buffer,
    okCodes: readonly number[] = [0]
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        // Tesseract would otherwise use every core; one image does not need them.
        env: { ...this.env, OMP_THREAD_LIMIT: '1' }
      })
      const chunks: Buffer[] = []
      let size = 0
      let errorText = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('the engine did not finish in time'))
      }, TIMEOUT_MS)
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > MAX_OUTPUT) {
          child.kill()
          return
        }
        chunks.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        errorText = (errorText + chunk.toString('utf8')).slice(-2_000)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (size > MAX_OUTPUT) reject(new Error('the engine produced too much output'))
        else if (code !== null && okCodes.includes(code)) resolve(Buffer.concat(chunks))
        else
          reject(
            new Error((errorText.trim().split(/\r?\n/).pop() ?? '') || `exit code ${String(code)}`)
          )
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(input)
    })
  }
}

/** Tesseract's TSV output: words (level 5) grouped into lines, with the mean confidence. */
export function parseTesseractTsv(tsv: string): TextLine[] {
  const lines = new Map<
    string,
    {
      words: string[]
      confidences: number[]
      left: number
      top: number
      right: number
      bottom: number
    }
  >()
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const cells = row.split('\t')
    if (cells.length < 12 || cells[0] !== '5') continue
    const text = (cells[11] ?? '').trim()
    const confidence = Number(cells[10])
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue
    const [left, top, width, height] = [6, 7, 8, 9].map((index) => Number(cells[index]))
    const key = `${cells[2] ?? ''}.${cells[3] ?? ''}.${cells[4] ?? ''}`
    const line = lines.get(key) ?? {
      words: [],
      confidences: [],
      left: Infinity,
      top: Infinity,
      right: 0,
      bottom: 0
    }
    line.words.push(text)
    line.confidences.push(confidence)
    line.left = Math.min(line.left, left ?? 0)
    line.top = Math.min(line.top, top ?? 0)
    line.right = Math.max(line.right, (left ?? 0) + (width ?? 0))
    line.bottom = Math.max(line.bottom, (top ?? 0) + (height ?? 0))
    lines.set(key, line)
  }
  return [...lines.values()].map((line) => ({
    text: line.words.join(' ').slice(0, 2_000),
    confidence:
      Math.round(
        (line.confidences.reduce((sum, value) => sum + value, 0) / line.confidences.length) * 10
      ) / 1_000,
    box:
      line.right > line.left && line.bottom > line.top
        ? {
            x: Math.max(0, Math.round(line.left)),
            y: Math.max(0, Math.round(line.top)),
            width: Math.round(line.right - line.left),
            height: Math.round(line.bottom - line.top)
          }
        : null
  }))
}

/** zbarimg's XML: one symbol per code, with its type, polygon and data. */
export function parseZbarXml(xml: string): HostQrResult['codes'] {
  const codes: HostQrResult['codes'] = []
  for (const symbol of xml.matchAll(/<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g)) {
    const kind = /\btype='([^']*)'/.exec(symbol[1] ?? '')?.[1] ?? 'unknown'
    const data = /<data>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/data>/.exec(symbol[2] ?? '')
    const value = data?.[1] ?? data?.[2] ?? ''
    const points = [
      ...(/points='([^']*)'/.exec(symbol[2] ?? '')?.[1] ?? '').matchAll(/([+-]?\d+),([+-]?\d+)/g)
    ].map((point) => ({ x: Number(point[1]), y: Number(point[2]) }))
    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    codes.push({
      value: value.slice(0, 4_000),
      kind: kind.slice(0, 40),
      box:
        points.length > 1 && Math.max(...xs) > Math.min(...xs) && Math.max(...ys) > Math.min(...ys)
          ? {
              x: Math.max(0, Math.min(...xs)),
              y: Math.max(0, Math.min(...ys)),
              width: Math.max(...xs) - Math.min(...xs),
              height: Math.max(...ys) - Math.min(...ys)
            }
          : null
    })
  }
  return codes.slice(0, 50)
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}
