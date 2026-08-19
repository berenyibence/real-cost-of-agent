/**
 * The front door.
 *
 * This server has no authentication and hands out project names, working
 * directories and session titles to anything that asks. That is fine for a page
 * you opened yourself, and not fine for a page that opened it for you — see
 * `server/access.js` for the two ways that happens.
 *
 * The rules are asserted from both sides: the requests that must keep working,
 * and the ones that must not start.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { hostAllowed, originAllowed, requestAllowed } from '../server/access.js';

test('the documented way of running this is allowed', () => {
  assert.ok(hostAllowed('127.0.0.1:4319'));
  assert.ok(hostAllowed('localhost:4319'));
  assert.ok(hostAllowed('[::1]:4319'));
  // Without a port, which is what a reverse proxy or a curl on :80 produces.
  assert.ok(hostAllowed('127.0.0.1'));
  assert.ok(hostAllowed('localhost'));
});

test('binding to a LAN address still works, because people do that', () => {
  // `HOST=192.168.1.5` is documented, and reading your numbers from a laptop on
  // your own network must not become a 403.
  assert.ok(hostAllowed('192.168.1.5:4319'));
  assert.ok(hostAllowed('10.0.0.2:4400'));
  assert.ok(hostAllowed('[fe80::1]:4319'));
});

test('a domain name is refused, which is what stops DNS rebinding', () => {
  // The attack needs the browser to send a Host it can control. It cannot send
  // one naming an address it did not resolve, so refusing names ends it.
  assert.equal(hostAllowed('evil.example:4319'), false);
  assert.equal(hostAllowed('evil.example'), false);
  // Including anything that merely contains a loopback name.
  assert.equal(hostAllowed('localhost.evil.example:4319'), false);
  assert.equal(hostAllowed('127.0.0.1.evil.example:4319'), false);
});

test('a missing or empty Host is refused rather than assumed to be local', () => {
  assert.equal(hostAllowed(undefined), false);
  assert.equal(hostAllowed(''), false);
  assert.equal(hostAllowed(':4319'), false);
  // A bracket with no closing bracket must not read as a valid literal.
  assert.equal(hostAllowed('[::1:4319'), false);
});

test('a request with no Origin is allowed, because that is the ordinary case', () => {
  // Browsers omit it on same-origin navigation; curl never sends one.
  assert.ok(originAllowed({ origin: undefined, host: '127.0.0.1:4319' }));
  assert.ok(originAllowed({ host: '127.0.0.1:4319' }));
});

test('a same-origin Origin is allowed', () => {
  assert.ok(originAllowed({ origin: 'http://127.0.0.1:4319', host: '127.0.0.1:4319' }));
  assert.ok(originAllowed({ origin: 'http://localhost:4319', host: 'localhost:4319' }));
});

test('a cross-site Origin is refused, which is what stops a silent plan rewrite', () => {
  // `POST /api/billing` with `content-type: text/plain` needs no preflight, so
  // this header is the only thing standing between a page you visit and your
  // stored plan.
  assert.equal(originAllowed({ origin: 'https://evil.example', host: '127.0.0.1:4319' }), false);
  // The same host on a different port is a different origin.
  assert.equal(originAllowed({ origin: 'http://127.0.0.1:4400', host: '127.0.0.1:4319' }), false);
  // A sandboxed frame sends the literal string.
  assert.equal(originAllowed({ origin: 'null', host: '127.0.0.1:4319' }), false);
});

test('both checks have to pass together', () => {
  assert.ok(requestAllowed({ host: '127.0.0.1:4319' }));
  assert.ok(requestAllowed({ host: '127.0.0.1:4319', origin: 'http://127.0.0.1:4319' }));
  // A good origin cannot rescue a rebound host, and vice versa.
  assert.equal(requestAllowed({ host: 'evil.example:4319' }), false);
  assert.equal(
    requestAllowed({ host: '127.0.0.1:4319', origin: 'https://evil.example' }),
    false,
  );
});
