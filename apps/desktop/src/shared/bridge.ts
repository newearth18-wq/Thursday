/**
 * The only API the renderer can reach: four request methods and one event
 * subscription, exposed by the sandboxed preload through contextBridge.
 * Every value crossing it is untrusted until validated — the main process
 * validates requests, the renderer validates replies.
 */
export interface JupiterBridge {
  getAppInfo(): Promise<unknown>
  getRuntimeStatus(): Promise<unknown>
  retryService(serviceId: string): Promise<unknown>
  reportRendererError(report: unknown): Promise<unknown>
  onRuntimeStatusChanged(listener: (payload: unknown) => void): () => void
}
