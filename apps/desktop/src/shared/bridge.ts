/**
 * The only API the renderer can reach (contract version 1): six request
 * functions bound to fixed channels and one message subscription, exposed
 * by the sandboxed preload through contextBridge. Every value crossing it is
 * untrusted until validated — the host validates requests, the renderer
 * validates replies and pushed messages.
 */
export interface JupiterBridge {
  gatewayStatus(): Promise<unknown>
  retryService(serviceId: string): Promise<unknown>
  request(envelope: unknown): Promise<unknown>
  cancel(requestId: string): Promise<unknown>
  subscribe(options: unknown): Promise<unknown>
  unsubscribe(subscriptionId: string): Promise<unknown>
  onMessage(listener: (message: unknown) => void): () => void
}
