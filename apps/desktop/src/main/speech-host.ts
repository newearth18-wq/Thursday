import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { SpokenLanguage, SystemSpeech, SystemVoices, VoiceOption } from '@jupiter/contracts'
import { JupiterError, type Logger } from '@jupiter/core'

/**
 * The operating system's own voice (SET 12), for spoken answers that never
 * leave this computer:
 *
 * - Windows: SAPI through `System.Speech` in a PowerShell process;
 * - elsewhere: espeak-ng, when it is installed.
 *
 * The text reaches the engine only on standard input (never on a command
 * line), and a voice name is used only if the engine listed it. Speech is
 * returned as WAV bytes in memory; nothing is written to disk.
 */

const TIMEOUT_MS = 60_000
const MAX_OUTPUT = 16 * 1024 * 1024

/** A PowerShell program that reads one JSON request from standard input. */
const SAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($request.op -eq 'voices') {
    $list = @()
    foreach ($installed in $synth.GetInstalledVoices()) {
      if ($installed.Enabled) {
        $info = $installed.VoiceInfo
        $list += [pscustomobject]@{ name = $info.Name; culture = $info.Culture.Name }
      }
    }
    [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ voices = @($list) }))
    exit 0
  }
  $synth.SelectVoice([string]$request.voice)
  $synth.Rate = [int]$request.rate
  $stream = New-Object System.IO.MemoryStream
  $synth.SetOutputToWaveStream($stream)
  $synth.Speak([string]$request.text)
  $synth.SetOutputToNull()
  [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ audio = [Convert]::ToBase64String($stream.ToArray()) }))
} finally {
  $synth.Dispose()
}
`

interface EngineRun {
  readonly command: string
  readonly args: readonly string[]
  readonly input: string
}

export interface SpeechHostOptions {
  readonly logger: Logger
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
}

export class SpeechHost {
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private cached: { at: number; value: SystemVoices } | null = null

  constructor(private readonly options: SpeechHostOptions) {
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
  }

  async voices(): Promise<SystemVoices> {
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.value
    const value = await this.listVoices()
    this.cached = { at: Date.now(), value }
    return value
  }

  async synthesize(input: {
    text: string
    language: SpokenLanguage
    voice: string | null
    rate: number
  }): Promise<SystemSpeech> {
    const listed = await this.voices()
    if (!listed.available)
      throw new JupiterError(
        'SYSTEM_VOICE_UNAVAILABLE',
        listed.reason ?? 'The system voice is unavailable.',
        { category: 'dependency', userAction: 'Choose a speech model as the voice source instead.' }
      )
    const voice = input.voice
      ? listed.voices.find((item) => item.id === input.voice)
      : listed.voices.find((item) => item.language.toLowerCase().startsWith(input.language))
    if (!voice)
      throw new JupiterError(
        'SYSTEM_VOICE_UNAVAILABLE',
        input.voice
          ? `The system has no voice called "${input.voice}".`
          : `The system has no ${input.language === 'th' ? 'Thai' : 'English'} voice.`,
        {
          category: 'dependency',
          userAction:
            'Install a voice for this language in the operating system, or choose a speech model as the voice source.'
        }
      )
    const bytes =
      this.platform === 'win32'
        ? await this.sapiSpeak(input.text, voice.id, input.rate)
        : await this.espeakSpeak(input.text, voice.id, input.rate)
    return {
      mediaType: 'audio/wav',
      audio: Buffer.from(bytes).toString('base64'),
      durationMs: wavDurationMs(bytes),
      voice: voice.name
    }
  }

  // ---- engines --------------------------------------------------------------------------------

  private async listVoices(): Promise<SystemVoices> {
    if (this.platform === 'win32') {
      try {
        const out = await this.run(sapiRun({ op: 'voices' }))
        const parsed = JSON.parse(out.toString('utf8')) as {
          voices?: { name?: unknown; culture?: unknown }[]
        }
        const voices: VoiceOption[] = (parsed.voices ?? [])
          .filter(
            (item): item is { name: string; culture: string } =>
              typeof item.name === 'string' && typeof item.culture === 'string'
          )
          .map((item) => ({
            id: item.name.slice(0, 120),
            name: item.name.slice(0, 200),
            language: item.culture.slice(0, 20),
            source: 'system',
            locality: 'this-device'
          }))
        return voices.length
          ? { available: true, reason: null, engine: 'Windows SAPI', voices }
          : {
              available: false,
              reason: 'Windows has no speech voices installed.',
              engine: 'Windows SAPI',
              voices: []
            }
      } catch (error) {
        return {
          available: false,
          reason: `Windows speech could not be started: ${messageOf(error)}`,
          engine: 'Windows SAPI',
          voices: []
        }
      }
    }
    const espeak = this.findEspeak()
    if (!espeak)
      return {
        available: false,
        reason: 'No system voice: espeak-ng is not installed on this computer.',
        engine: null,
        voices: []
      }
    const voices: VoiceOption[] = []
    for (const language of ['en', 'th'] as const) {
      try {
        const out = (await this.run({ command: espeak, args: [`--voices=${language}`], input: '' }))
          .toString('utf8')
          .split('\n')
          .slice(1)
        for (const line of out) {
          const columns = line.trim().split(/\s+/)
          const code = columns[1]
          const name = columns[3]
          const file = columns[4] ?? ''
          if (!code || !name || !code.toLowerCase().startsWith(language)) continue
          // MBROLA voices need extra voice data that is usually not installed.
          if (file.startsWith('mb/')) continue
          if (voices.some((voice) => voice.id === code)) continue
          voices.push({
            id: code.slice(0, 120),
            name: `${name.replace(/_/g, ' ')} (espeak-ng)`.slice(0, 200),
            language: code.slice(0, 20),
            source: 'system',
            locality: 'this-device'
          })
        }
      } catch (error) {
        this.options.logger.warn('speech.voices.failed', 'espeak-ng could not list voices', {
          language,
          problem: messageOf(error)
        })
      }
    }
    return voices.length
      ? { available: true, reason: null, engine: 'espeak-ng', voices }
      : { available: false, reason: 'espeak-ng lists no voices.', engine: 'espeak-ng', voices: [] }
  }

  private sapiSpeak(text: string, voice: string, rate: number): Promise<Buffer> {
    // SAPI rate is -10…10; 2× normal speed is about +10.
    const sapiRate = Math.max(-10, Math.min(10, Math.round(Math.log2(rate) * 10)))
    return this.run(sapiRun({ op: 'speak', text, voice, rate: sapiRate })).then((out) => {
      const parsed = JSON.parse(out.toString('utf8')) as { audio?: unknown }
      if (typeof parsed.audio !== 'string') throw new Error('SAPI returned no audio')
      return Buffer.from(parsed.audio, 'base64')
    })
  }

  private async espeakSpeak(text: string, voice: string, rate: number): Promise<Buffer> {
    const espeak = this.findEspeak()
    if (!espeak) throw new Error('espeak-ng is not installed')
    // espeak-ng's normal speed is 175 words per minute.
    const wordsPerMinute = String(Math.round(175 * rate))
    return this.run({
      command: espeak,
      args: ['--stdin', '--stdout', '-v', voice, '-s', wordsPerMinute],
      input: text
    })
  }

  private findEspeak(): string | null {
    for (const directory of (this.env.PATH ?? '').split(delimiter)) {
      if (!directory) continue
      const candidate = join(directory, 'espeak-ng')
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  private run(run: EngineRun): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(run.command, [...run.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      })
      const chunks: Buffer[] = []
      let size = 0
      let errorText = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('the speech engine did not finish in time'))
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
        if (size > MAX_OUTPUT) reject(new Error('the speech engine produced too much output'))
        else if (code === 0) resolve(Buffer.concat(chunks))
        else
          reject(
            new Error((errorText.trim().split('\n').pop() ?? '') || `exit code ${String(code)}`)
          )
      })
      child.stdin.end(run.input, 'utf8')
    })
  }
}

function sapiRun(request: Record<string, unknown>): EngineRun {
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(SAPI_SCRIPT, 'utf16le').toString('base64')
    ],
    input: JSON.stringify(request)
  }
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

/** Length of a PCM WAV in milliseconds, from its header; 0 when it cannot be read. */
export function wavDurationMs(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 44) return 0
  let offset = 12
  let byteRate = 0
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') byteRate = view.getUint32(offset + 16, true)
    if (id === 'data') {
      // espeak-ng writes 0xFFFFFFFF as the size when it streams; use what is really there.
      const available = Math.min(size, bytes.byteLength - offset - 8)
      return byteRate ? Math.round((available / byteRate) * 1000) : 0
    }
    offset += 8 + size + (size % 2)
  }
  return 0
}

// ---- the microphone gate --------------------------------------------------------------------

/**
 * The host refuses the microphone to the interface unless Jupiter Core has
 * opened this gate for a listening session the person started (or, for a
 * few seconds, to name the devices). Closed by default; closes itself when
 * its time runs out.
 */
export class MicrophoneGate {
  private state: {
    sessionId: string
    purpose: 'listen' | 'devices'
    until: number
  } | null = null

  constructor(private readonly now: () => number = Date.now) {}

  set(input: {
    sessionId: string
    purpose: 'listen' | 'devices'
    open: boolean
    until: string | null
  }): boolean {
    if (!input.open) {
      if (!this.state || this.state.sessionId === input.sessionId) this.state = null
      return false
    }
    const until = input.until ? Date.parse(input.until) : this.now() + 15_000
    this.state = { sessionId: input.sessionId, purpose: input.purpose, until }
    return this.isOpen()
  }

  isOpen(): boolean {
    if (this.state && this.state.until <= this.now()) this.state = null
    return this.state !== null
  }

  /** Whether a new capture may start: only for a listening session. */
  mayCapture(): boolean {
    return this.isOpen() && this.state?.purpose === 'listen'
  }
}
