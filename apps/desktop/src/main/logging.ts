import { Logger, createConsoleSink } from '@jupiter/core'
import { RotatingFileSink } from '@jupiter/core/node'
import type { MainEnvironment } from './environment'

export interface MainLogging {
  readonly logger: Logger
  readonly fileSink: RotatingFileSink
  /** Installed once the supervisor exists, so write failures surface as a FAILED logging service. */
  setWriteErrorHandler(handler: (error: unknown) => void): void
}

/**
 * Console + rotating JSON Lines file. The file is not opened here: the
 * `logging` service opens it, so a broken log directory is reported as a real
 * service failure instead of crashing startup. Until then entries are buffered.
 */
export function createMainLogging(env: MainEnvironment, sessionId: string): MainLogging {
  let writeErrorHandler: ((error: unknown) => void) | null = null
  const fileSink = new RotatingFileSink({
    directory: env.logsDir,
    baseName: 'jupiter',
    maxFileBytes: env.profile.logRotation.maxFileBytes,
    maxFiles: env.profile.logRotation.maxFiles,
    onWriteError: (error) => writeErrorHandler?.(error)
  })
  const logger = Logger.create({
    sessionId,
    level: env.profile.logLevel,
    component: 'main',
    sinks: [createConsoleSink(env.profile.consoleFormat), fileSink]
  })
  return {
    logger,
    fileSink,
    setWriteErrorHandler(handler) {
      writeErrorHandler = handler
    }
  }
}
