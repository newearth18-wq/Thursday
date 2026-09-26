import {
  isProtectedTransport,
  localityOf,
  type Locality,
  type RoutingMode
} from '@jupiter/contracts'
import { JupiterError, describeError } from '../errors'
import type { Transport, TransportRequest } from './adapter'
import { ProviderError } from './adapter'

/**
 * The only way provider adapters reach the network.
 *
 * Checked on every single request, whatever the adapter or the router
 * decided before:
 *  - in `LOCAL_ONLY` mode, an address that is not on this computer is
 *    refused before a connection is opened — no prompt, metadata or key
 *    leaves the machine;
 *  - redirects are refused (a local endpoint cannot bounce a request to the
 *    cloud);
 *  - an API key is only sent over https, or to this computer.
 */

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>

export interface BlockedRequest {
  readonly locality: Locality
  readonly mode: RoutingMode
}

export interface TransportOptions {
  readonly fetch: FetchLike
  /** The mode that applies to this request (already resolved for the conversation). */
  readonly mode: RoutingMode
  readonly providerName: string
  readonly onBlocked: (blocked: BlockedRequest) => void
}

export function privacyBlocked(providerName: string): JupiterError {
  return new JupiterError(
    'PRIVACY_MODE_BLOCKED',
    `Local only mode is on, so nothing was sent to ${providerName}: it is not on this computer.`,
    {
      category: 'permission',
      userAction:
        'Use a model that runs on this computer, or change the routing mode in AI models.',
      retryable: false
    }
  )
}

export function createTransport(options: TransportOptions): Transport {
  return {
    async request(url: URL, init: TransportRequest): Promise<Response> {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new JupiterError('INVALID_PROVIDER_ADDRESS', 'Provider addresses must be http(s).', {
          category: 'configuration',
          userAction: 'Correct the provider address in AI models.'
        })
      }
      const locality = localityOf(url.href)
      if (options.mode === 'LOCAL_ONLY' && locality !== 'this-device') {
        options.onBlocked({ locality, mode: options.mode })
        throw privacyBlocked(options.providerName)
      }
      if (init.carriesSecret && !isProtectedTransport(url.href)) {
        throw new JupiterError(
          'INSECURE_TRANSPORT',
          `The API key for ${options.providerName} was not sent: the address uses http:// to another computer, which would expose it.`,
          {
            category: 'configuration',
            userAction: 'Use an https:// address for this provider.'
          }
        )
      }
      try {
        return await options.fetch(url, {
          method: init.method,
          headers: init.headers,
          ...(init.body === undefined ? {} : { body: init.body }),
          signal: init.signal,
          redirect: 'error'
        })
      } catch (error) {
        if (init.signal.aborted) {
          throw new JupiterError('CANCELLED', 'The request was stopped.', {
            category: 'cancellation',
            userAction: null,
            cause: error
          })
        }
        throw new ProviderError(
          'PROVIDER_UNREACHABLE',
          `${options.providerName} could not be reached at ${url.origin}: ${describeCause(error)}.`,
          { cause: error }
        )
      }
    }
  }
}

/** Node's fetch hides the useful part (ECONNREFUSED, ENOTFOUND…) in `cause`. */
function describeCause(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause
  const code = (cause as { code?: unknown } | undefined)?.code
  if (typeof code === 'string') return code
  return describeError(cause ?? error)
}
