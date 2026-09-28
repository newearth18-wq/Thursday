import { spawn } from 'node:child_process'
import {
  MAX_IMAGE_BYTES,
  type HostFaceResult,
  type HostHelloResult,
  type HostIdentityEngines
} from '@jupiter/contracts'
import { JupiterError, type Logger } from '@jupiter/core'
import { IdentityRuntimeError, type IdentityRuntime } from '@jupiter/identity-runtime'
import { decodePng, downscale, isPng, PngError, rgbOf, type Bitmap } from './png'

/**
 * The host side of the Identity Engine (SET 14).
 *
 * - Faces: the image is decoded here, made at most 640 pixels on its longer
 *   side, and its pixels go to the identity runtime (face-api in its own
 *   process). Only boxes, detector scores and descriptors come back; the
 *   image is never written anywhere.
 * - Windows Hello: Windows' own verifier (`UserConsentVerifier`), through
 *   Windows PowerShell with a fixed script; the message shown is the only
 *   input, passed as data on standard input. Windows handles the face,
 *   fingerprint or PIN — Jupiter never sees any of them.
 *
 * Every operation is for Jupiter Core only.
 */

const FACE_SIDE = 640
const HELLO_TIMEOUT_MS = 120_000

export interface IdentityHostOptions {
  readonly logger: Logger
  /** The identity runtime, or null when its files are missing (Face Identity is then unavailable). */
  readonly runtime: IdentityRuntime | null
  readonly platform?: NodeJS.Platform
}

export class IdentityHost {
  private readonly platform: NodeJS.Platform
  private faceEngine: Promise<{ name: string } | { reason: string }> | null = null
  private helloAvailability: Promise<HostHelloResult> | null = null

  constructor(private readonly options: IdentityHostOptions) {
    this.platform = options.platform ?? process.platform
  }

  async engines(): Promise<HostIdentityEngines> {
    const face = await this.faceEngineStatus()
    const hello = await this.helloStatus()
    return {
      face:
        'name' in face
          ? { available: true, reason: null, name: face.name }
          : { available: false, reason: face.reason, name: null },
      hello:
        hello.outcome === 'verified'
          ? { available: true, reason: null, name: 'Windows Hello' }
          : { available: false, reason: hello.detail, name: null }
    }
  }

  async face(image: { data: string }): Promise<HostFaceResult> {
    const runtime = this.options.runtime
    if (!runtime)
      throw new JupiterError(
        'FACE_ENGINE_UNAVAILABLE',
        'Face Identity is not available in this build.',
        {
          category: 'dependency',
          userAction: null
        }
      )
    const png = Buffer.from(image.data, 'base64')
    if (!isPng(png) || png.byteLength > MAX_IMAGE_BYTES)
      throw new JupiterError('IMAGE_INVALID', 'The image is not a PNG of at most 12 MB.', {
        category: 'validation',
        userAction: null
      })
    let bitmap: Bitmap
    try {
      bitmap = decodePng(png)
    } catch (error) {
      throw new JupiterError(
        'IMAGE_INVALID',
        error instanceof PngError ? error.message : 'The image could not be read.',
        { category: 'validation', userAction: null }
      )
    }
    const small = downscale(bitmap, FACE_SIDE)
    const scale = bitmap.width / small.width
    let found: { faces: HostFaceResult['faces'] }
    try {
      found = await runtime.call('describe', {
        width: small.width,
        height: small.height,
        rgb: rgbOf(small).toString('base64')
      })
    } catch (error) {
      throw new JupiterError(
        'FACE_ENGINE_FAILED',
        `The face engine could not look at the image: ${messageOf(error)}`,
        { category: 'dependency', userAction: 'Try again.', retryable: true }
      )
    }
    // Boxes in the image's own pixels.
    return {
      width: bitmap.width,
      height: bitmap.height,
      faces: found.faces.map((face) => {
        const x = Math.min(bitmap.width - 1, Math.round(face.box.x * scale))
        const y = Math.min(bitmap.height - 1, Math.round(face.box.y * scale))
        return {
          ...face,
          box: {
            x,
            y,
            width: Math.max(1, Math.min(bitmap.width - x, Math.round(face.box.width * scale))),
            height: Math.max(1, Math.min(bitmap.height - y, Math.round(face.box.height * scale)))
          }
        }
      })
    }
  }

  /** Asks Windows Hello. The dialog is Windows' own; Jupiter only learns the outcome. */
  async hello(input: { message: string }): Promise<HostHelloResult> {
    const status = await this.helloStatus()
    if (status.outcome !== 'verified') return status
    try {
      return parseHello(await this.powershell({ op: 'verify', message: input.message }))
    } catch (error) {
      return { outcome: 'failed', detail: `Windows Hello did not answer: ${messageOf(error)}` }
    }
  }

  // ---- internals ------------------------------------------------------------------------------

  private faceEngineStatus(): Promise<{ name: string } | { reason: string }> {
    const runtime = this.options.runtime
    if (!runtime)
      return Promise.resolve({ reason: 'Unavailable: the face engine is not part of this build.' })
    this.faceEngine ??= runtime
      .call('status', {})
      .then((status) => ({ name: status.engine }))
      .catch((error: unknown) => {
        this.faceEngine = null
        this.options.logger.warn('identity.face.unavailable', 'The face engine did not start', {
          reason: messageOf(error)
        })
        return {
          reason: `Unavailable: the face engine did not start (${error instanceof IdentityRuntimeError ? error.code : 'error'}).`
        }
      })
    return this.faceEngine
  }

  /** `verified` here means "available": Windows Hello is set up for this user. */
  private helloStatus(): Promise<HostHelloResult> {
    if (this.platform !== 'win32')
      return Promise.resolve({
        outcome: 'unavailable',
        detail: 'Unavailable: Windows Hello exists only on Windows.'
      })
    this.helloAvailability ??= this.powershell({ op: 'check', message: 'Jupiter' })
      .then(parseHello)
      .catch((error: unknown) => {
        this.helloAvailability = null
        return {
          outcome: 'unavailable' as const,
          detail: `Unavailable: Windows Hello could not be asked (${messageOf(error)}).`
        }
      })
    return this.helloAvailability
  }

  private powershell(request: { op: 'check' | 'verify'; message: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          Buffer.from(HELLO_SCRIPT, 'utf16le').toString('base64')
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false, shell: false }
      )
      let out = ''
      let errorText = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('no answer within two minutes'))
      }, HELLO_TIMEOUT_MS)
      child.stdout.on('data', (chunk: Buffer) => {
        out = (out + chunk.toString('utf8')).slice(-4_000)
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
        if (code === 0) resolve(out)
        else
          reject(
            new Error((errorText.trim().split('\n').pop() ?? '') || `exit code ${String(code)}`)
          )
      })
      child.stdin.end(JSON.stringify(request), 'utf8')
    })
  }
}

/** Windows' answer, as one line of JSON: `{"result": "<UserConsentVerifier result>"}`. */
export function parseHello(output: string): HostHelloResult {
  const line = output.trim().split('\n').pop() ?? ''
  let parsed: unknown
  try {
    parsed = (JSON.parse(line) as { result?: unknown }).result
  } catch {
    return { outcome: 'failed', detail: 'Windows Hello gave an answer Jupiter cannot read.' }
  }
  const result = typeof parsed === 'string' ? parsed : ''
  switch (result) {
    case 'Available':
    case 'Verified':
      return { outcome: 'verified', detail: null }
    case 'Canceled':
      return { outcome: 'cancelled', detail: 'You cancelled Windows Hello.' }
    case 'DeviceNotPresent':
      return {
        outcome: 'not-configured',
        detail: 'Not configured: this computer has no Windows Hello device.'
      }
    case 'NotConfiguredForUser':
      return {
        outcome: 'not-configured',
        detail:
          'Not configured: set up Windows Hello (a PIN, face or fingerprint) in Windows Settings › Accounts › Sign-in options.'
      }
    case 'DisabledByPolicy':
      return {
        outcome: 'not-configured',
        detail: 'Not configured: Windows Hello is turned off by policy on this computer.'
      }
    case 'DeviceBusy':
      return { outcome: 'failed', detail: 'Windows Hello is busy. Try again.' }
    case 'RetriesExhausted':
      return {
        outcome: 'failed',
        detail: 'Too many attempts: Windows Hello refused to try again now.'
      }
    default:
      return { outcome: 'failed', detail: `Windows Hello answered "${result.slice(0, 60)}".` }
  }
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

/**
 * Asks Windows' UserConsentVerifier. Reads `{op, message}` from standard input;
 * writes `{"result": "..."}`. WinRT is reached from Windows PowerShell 5.1.
 */
const HELLO_SCRIPT = `
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
} | Select-Object -First 1
function Await($operation, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}
$null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
if ($request.op -eq 'check') {
  $result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
} else {
  $result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync([string]$request.message)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
}
[Console]::Out.WriteLine((@{ result = [string]$result } | ConvertTo-Json -Compress))
`
