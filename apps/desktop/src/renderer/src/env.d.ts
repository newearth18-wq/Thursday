import type { JupiterBridge } from '../../shared/bridge'

declare global {
  interface Window {
    /** Present only when the preload bridge loaded; the UI reports its absence truthfully. */
    readonly jupiter?: JupiterBridge
  }
}

export {}
