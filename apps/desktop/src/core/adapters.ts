import type { ProviderAdapter } from '@jupiter/core'
import { anthropicAdapter, openAiCompatibleAdapter } from '@jupiter/providers'

/**
 * The provider adapters installed in this build of Jupiter.
 *
 * This list — not Jupiter Core — decides which provider protocols exist.
 * Adding a protocol means adding an adapter (implementing Core's adapter
 * port) and listing it here; removing one means removing it here. Providers
 * a person configured with an adapter that is no longer installed are shown
 * as "adapter not installed" and are never used, and nothing else breaks.
 */
export function installedAdapters(): ProviderAdapter[] {
  return [openAiCompatibleAdapter(), anthropicAdapter()]
}
