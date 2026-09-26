/**
 * Content Security Policy for the renderer.
 *
 * Production allows nothing but the app's own bundled files: no inline or
 * evaluated script, no remote content, no network connections, no frames.
 * It is sent both as a response header by the `jupiter://` protocol handler
 * and as a meta tag in index.html. The dev server additionally needs inline
 * scripts (React Refresh), inline styles (Vite CSS injection) and its own
 * loopback websocket; that relaxation exists only in `electron-vite dev`.
 */
export const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ')

export const DEVELOPMENT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self'",
  'connect-src ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*',
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'"
].join('; ')
