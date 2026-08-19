/**
 * Who is allowed to talk to this server.
 *
 * There is no authentication here, and there should not be — it is a local page
 * reading local files, and a password on it would be a password protecting you
 * from yourself. But "only reachable from this machine" is not the same as
 * "only reachable by you": a browser is a confused deputy by design, and this
 * server will hand out your project names, your working directories and your
 * session titles to anything that asks.
 *
 * Two ways in, both closed by a string compare.
 *
 * **DNS rebinding.** A page you are looking at resolves `evil.example` to
 * `127.0.0.1`, waits for the browser's DNS cache to turn over, and then fetches
 * `http://evil.example:4319/api/spend`. Same origin as far as the browser is
 * concerned, so it reads the response. That request arrives here with
 * `Host: evil.example` — and a browser cannot be induced to send a Host header
 * naming an address it did not resolve. Requiring the host to be `localhost` or
 * a bare IP literal is therefore a complete answer rather than a mitigation.
 *
 * **Cross-site writes.** `POST /api/billing` with `content-type: text/plain` is
 * a CORS *simple* request: no preflight, so nothing on the browser side stops a
 * page you are visiting from issuing it. The body would parse fine, because
 * this server never inspects the content type. The attacker cannot read the
 * reply, but they do not need to — they have already rewritten the plan your
 * comparison is measured against. So an `Origin` naming anywhere but this
 * server is refused.
 *
 * Neither rule affects a browser pointed at the documented URL, and allowing
 * bare IPs is what keeps `HOST=192.168.1.5` working for somebody reading their
 * numbers from a laptop on their own network.
 */

import net from 'node:net';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * The hostname out of a `Host` header, without its port.
 * An IPv6 literal is bracketed, so its colons are not port separators.
 */
function hostname(hostHeader) {
  const raw = String(hostHeader);
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    return close === -1 ? '' : raw.slice(1, close);
  }
  return raw.split(':')[0];
}

/** True when the `Host` header names this machine rather than somebody's domain. */
export function hostAllowed(hostHeader) {
  // HTTP/1.1 requires the header. Anything omitting it is not a browser, and
  // this is not an API worth being lenient for.
  if (!hostHeader) return false;
  const host = hostname(hostHeader).toLowerCase();
  if (!host) return false;
  return LOOPBACK_NAMES.has(host) || net.isIP(host) !== 0;
}

/**
 * True when the request is same-origin, or carries no `Origin` at all.
 *
 * Absent is the ordinary case: browsers omit it on same-origin navigations, and
 * curl never sends one. Present and different means a page somewhere else asked
 * for this, which is the whole attack.
 */
export function originAllowed({ origin, host } = {}) {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    // Includes the literal `Origin: null` a sandboxed frame sends.
    return false;
  }
}

/** Both checks, against a request's headers. */
export function requestAllowed(headers = {}) {
  return hostAllowed(headers.host) && originAllowed({ origin: headers.origin, host: headers.host });
}
