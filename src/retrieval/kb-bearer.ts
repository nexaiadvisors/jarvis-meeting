// Decides whether the kb-server bearer (KB_BACKEND_TOKEN) may be sent to a URL.
//
// The token is David's credential for ONE service: the work-scoped kb-server. A SOUL
// names its own knowledge-backend endpoint, so a second delegate SOUL, a team (ai)
// SOUL or a mistyped endpoint must never receive it. The kb-server's origin is taken
// from KB_BACKEND_HEALTH_URL (the same service's /healthz), and the token is attached
// only to a URL whose origin (scheme + host + port) is exactly that origin. With no
// token, or with the health URL unset or unparseable, it is never attached.

import type { Config } from '../config.js';

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    // Opaque origins (file:, data:, ...) serialize to "null"; two of them must not match.
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** The bearer for a request to `targetUrl`, or undefined when it must not carry one. */
export function kbBearerFor(
  config: Pick<Config, 'kbBackendToken' | 'kbBackendHealthUrl'>,
  targetUrl: string,
): string | undefined {
  const token = config.kbBackendToken;
  if (!token) return undefined;
  const allowed = originOf(config.kbBackendHealthUrl);
  const target = originOf(targetUrl);
  return allowed !== undefined && allowed === target ? token : undefined;
}
