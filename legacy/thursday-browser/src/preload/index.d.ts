import type { ThursdayApi } from '../shared/ipc.js'

declare global {
  interface Window {
    thursday: ThursdayApi
  }
}

export {}
