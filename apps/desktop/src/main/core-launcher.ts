import { utilityProcess } from 'electron'
import type { CoreChild, CoreLauncher } from './core-process'

/** Starts Jupiter Core as an Electron utility process: a separate OS process with its own crash domain. */
export function electronCoreLauncher(modulePath: string): CoreLauncher {
  return {
    launch(): CoreChild {
      const child = utilityProcess.fork(modulePath, [], {
        serviceName: 'Jupiter Core',
        stdio: 'pipe'
      })
      return {
        get pid() {
          return child.pid
        },
        postMessage(message) {
          child.postMessage(message)
        },
        kill() {
          child.kill()
        },
        onMessage(listener) {
          child.on('message', listener)
        },
        onExit(listener) {
          child.on('exit', (code) => {
            listener(code)
          })
        },
        onOutput(listener) {
          child.stdout?.on('data', (chunk: Buffer) => {
            listener('stdout', chunk.toString('utf8'))
          })
          child.stderr?.on('data', (chunk: Buffer) => {
            listener('stderr', chunk.toString('utf8'))
          })
        }
      }
    }
  }
}
