import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as tf from '@tensorflow/tfjs'
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm'
import * as faceapi from '@vladmandic/face-api/dist/face-api.node-wasm.js'
import {
  RuntimeOps,
  RuntimeRequest,
  isRuntimeOp,
  type RuntimeOp,
  type RuntimeReply
} from './protocol'

/**
 * The identity runtime process (SET 14). It finds faces in the pixels the
 * host sends and describes each with face-api's 128-number descriptor, on
 * TensorFlow.js's WebAssembly backend. It holds nothing between requests
 * (the models aside), writes nothing and opens no network connection: the
 * model files and the WebAssembly binaries are read from the folder the
 * host names in `JUPITER_IDENTITY_ASSETS`.
 */

class RuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

const MODELS = [
  'ssd_mobilenetv1_model',
  'face_landmark_68_model',
  'face_recognition_model'
] as const
const ENGINE = 'face-api 1.7.15 (SSD MobileNet v1, 68 landmarks, ResNet-34 descriptor)'
let ready: Promise<string> | null = null

function assets(): string {
  const dir = process.env.JUPITER_IDENTITY_ASSETS
  if (!dir) throw new RuntimeError('ENGINE_UNAVAILABLE', 'The face models were not found.')
  return dir
}

function loadModels(): Promise<string> {
  ready ??= (async () => {
    const dir = assets()
    // The WebAssembly binaries sit next to the models; nothing is fetched.
    setWasmPaths(join(dir, '/'))
    await tf.setBackend('wasm')
    await tf.ready()
    const nets = {
      ssd_mobilenetv1_model: faceapi.nets.ssdMobilenetv1,
      face_landmark_68_model: faceapi.nets.faceLandmark68Net,
      face_recognition_model: faceapi.nets.faceRecognitionNet
    }
    for (const name of MODELS) {
      const manifest = JSON.parse(
        readFileSync(join(dir, `${name}-weights_manifest.json`), 'utf8')
      ) as { weights: Parameters<typeof tf.io.decodeWeights>[1] }[]
      const bytes = readFileSync(join(dir, `${name}.bin`))
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      // face-api declares its own copy of TensorFlow.js's types; at run time they are one module.
      nets[name].loadFromWeightMap(tf.io.decodeWeights(buffer, manifest[0]?.weights ?? []) as never)
    }
    return tf.getBackend()
  })()
  ready.catch(() => {
    ready = null
  })
  return ready
}

async function describe(params: { width: number; height: number; rgb: string }) {
  await loadModels()
  const bytes = Buffer.from(params.rgb, 'base64')
  if (bytes.length !== params.width * params.height * 3)
    throw new RuntimeError('INVALID_IMAGE', 'The pixels do not match the size of the image.')
  const input = tf.tensor3d(new Int32Array(bytes), [params.height, params.width, 3], 'int32')
  try {
    const found = await faceapi
      .detectAllFaces(
        input as unknown as faceapi.TNetInput,
        new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5, maxResults: 10 })
      )
      .withFaceLandmarks()
      .withFaceDescriptors()
    return {
      faces: found.map((face) => {
        const box = face.detection.box
        const x = Math.max(0, Math.floor(box.x))
        const y = Math.max(0, Math.floor(box.y))
        return {
          box: {
            x,
            y,
            width: Math.max(1, Math.min(params.width - x, Math.round(box.width))),
            height: Math.max(1, Math.min(params.height - y, Math.round(box.height)))
          },
          score: Math.min(1, Math.max(0, face.detection.score)),
          descriptor: Array.from(face.descriptor)
        }
      })
    }
  } finally {
    input.dispose()
  }
}

const handlers: Record<RuntimeOp, (params: never) => Promise<unknown>> = {
  ping: () => Promise.resolve({ pid: process.pid }),
  status: async () => ({ engine: ENGINE, backend: await loadModels() }),
  describe: (params: { width: number; height: number; rgb: string }) => describe(params)
}

function send(reply: RuntimeReply): void {
  process.send?.(reply)
}

function errorOf(error: unknown): { code: string; message: string } {
  if (error instanceof RuntimeError) return { code: error.code, message: error.message }
  const code = (error as { code?: unknown }).code
  if (code === 'ENOENT')
    return { code: 'ENGINE_UNAVAILABLE', message: 'The face models were not found.' }
  return {
    code: 'FACE_ENGINE_FAILED',
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
  }
}

async function handle(raw: unknown): Promise<void> {
  const request = RuntimeRequest.safeParse(raw)
  if (!request.success) return
  const { id, op, params } = request.data
  try {
    if (!isRuntimeOp(op)) throw new RuntimeError('UNKNOWN_OPERATION', `Unknown operation ${op}.`)
    const parsed = RuntimeOps[op].params.safeParse(params)
    if (!parsed.success)
      throw new RuntimeError(
        'INVALID_PAYLOAD',
        `Invalid parameters for ${op}: ${parsed.error.message}`
      )
    const handler = handlers[op] as (input: unknown) => Promise<unknown>
    send({ id, ok: true, result: await handler(parsed.data) })
  } catch (error) {
    send({ id, ok: false, error: errorOf(error) })
  }
}

process.on('message', (message) => {
  void handle(message)
})
process.on('disconnect', () => {
  process.exit(0)
})
send({ id: 0, ok: true, result: { pid: process.pid } })
