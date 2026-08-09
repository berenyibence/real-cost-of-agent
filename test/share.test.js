/**
 * The share card.
 *
 * A page that prices your work is a private thing; a post is the opposite. The
 * whole risk of this feature lives in the gap between them, and it is not a
 * hypothetical one: the spend payload carries `~/dev/acme-billing-rewrite` in
 * three separate fields and session titles that are literally the first thing
 * somebody typed at the agent.
 *
 * So the tests below are mostly one test asked several ways: does anything that
 * identifies what you were working on reach the text, the image or a URL?
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORMATS,
  REPO_URL,
  dollars,
  hackerNewsTitle,
  headline,
  redditTitle,
  shareFacts,
  shareTargets,
  shareText,
  shareable,
} from '../web/share.js';

/**
 * A payload shaped like `/api/spend`, with something identifying planted in
 * every field that carries one. If any of these strings turns up downstream,
 * the allowlist in `shareFacts` has grown a hole.
 */
const SECRETS = [
  '/Users/ada/dev/acme-billing-rewrite',
  'acme-billing-rewrite',
  'Fix the payroll export before Sunday',
  'ada',
  'stripe-migration',
];

const payload = {
  total: 1284.42,
  uncached: 4102.9,
  saved: 2818.48,
  components: [
    { id: 'output', label: 'Output', cost: 780.1, share: 0.607, tokens: 5_200_000 },
    { id: 'cacheRead', label: 'Cache read', cost: 280.2, share: 0.218, tokens: 910_000_000 },
    { id: 'cacheWrite5m', label: 'Cache write (5m)', cost: 160.0, share: 0.125, tokens: 41_000_000 },
    { id: 'input', label: 'Fresh input', cost: 64.12, share: 0.05, tokens: 8_400_000 },
    { id: 'cacheWrite1h', label: 'Cache write (1h)', cost: 0, share: 0, tokens: 0 },
  ],
  byProject: [
    { id: 'acme-billing-rewrite', name: 'acme-billing-rewrite', path: '/Users/ada/dev/acme-billing-rewrite', cost: 900 },
    { id: 'stripe-migration', name: 'stripe-migration', path: '/Users/ada/dev/stripe-migration', cost: 384.42 },
  ],
  byModel: [{ id: 'claude-opus-5', name: 'Claude Opus 5', cost: 1284.42 }],
  byDay: [{ id: '2026-07-01', date: '2026-07-01', cost: 1284.42 }],
  topSessions: [
    { id: 's1', name: 'Fix the payroll export before Sunday', project: 'acme-billing-rewrite', cost: 210.5 },
  ],
  billing: {
    authMode: 'subscription',
    authEvidence: 'oauth beta present in 44 of 60 sampled telemetry events',
    plan: { id: 'max20', name: 'Claude Max 20×', monthly: 200 },
    months: 3,
    apiEquivalent: 1284.42,
    subscriptionCost: 600,
    saved: 684.42,
    ratio: 2.1407,
    apiCreditsSpent: 0,
    onSubscription: true,
  },
  meta: {
    sessions: 258,
    workspaces: 12,
    claudeDir: '/Users/ada/.claude',
    found: true,
  },
};

/** Every string a post can produce, from one payload. */
function everythingShareable(spend) {
  const f = shareFacts(spend);
  return [
    JSON.stringify(f),
    shareText(f, { tone: 'short' }),
    shareText(f, { tone: 'long' }),
    headline(f),
    redditTitle(f),
    hackerNewsTitle(),
    ...shareTargets(f).flatMap((t) => [t.href ?? '', t.label, t.note ?? '']),
  ].join('\n');
}

test('nothing identifying about the work reaches a post', () => {
  const everything = everythingShareable(payload);
  for (const secret of SECRETS) {
    assert.equal(
      everything.includes(secret),
      false,
      `"${secret}" reached a shareable string:\n${everything}`,
    );
  }
  // The home directory is the one that would be embarrassing in a screenshot.
  assert.equal(/\/Users\/|\/home\/|C:\\\\/.test(everything), false, everything);
});

test('the facts are an allowlist, so a new spend field is not shared by accident', () => {
  const facts = shareFacts({ ...payload, secretNewField: 'acme-billing-rewrite' });
  assert.equal('secretNewField' in facts, false);
  assert.deepEqual(
    Object.keys(facts).sort(),
    [
      'apiCreditsSpent',
      'months',
      'paid',
      'planName',
      'projects',
      'ratio',
      'sessions',
      'split',
      'subscription',
      'total',
    ],
    'a key changed here — check it carries no project, path or session title',
  );
  // The split is the only nested shape, and it is three scalars per row.
  for (const part of facts.split) {
    assert.deepEqual(Object.keys(part).sort(), ['id', 'label', 'share']);
  }
});

test('a subscription is described as value received, never as money charged', () => {
  const f = shareFacts(payload);
  const text = shareText(f, { tone: 'short' });

  assert.equal(f.subscription, true);
  assert.equal(f.paid, 600, 'the plan over the months it spans, not one month');
  assert.match(text, /2\.1×/);
  assert.match(text, /\$1,284/);
  assert.match(text, /Claude Max 20×/);
  // The post says what the plan cost. Claiming $1,284 was *spent* is the one
  // sentence this project exists to not write.
  assert.equal(/I (spent|paid) \$1,284/.test(text), false, text);
});

test('API billing is not dressed up as a saving', () => {
  const f = shareFacts({
    ...payload,
    billing: {
      ...payload.billing,
      authMode: 'api',
      subscriptionCost: 0,
      ratio: null,
      apiCreditsSpent: 1284.42,
      onSubscription: false,
    },
  });

  assert.equal(f.subscription, false);
  assert.equal(f.planName, null);
  assert.equal(f.ratio, null);
  const text = shareText(f, { tone: 'short' });
  assert.match(text, /billed straight to API credits/i);
  assert.equal(/value|returned|saved/i.test(text), false, text);
});

test('a short post clears 280 characters, so the link is never what gets truncated', () => {
  // The worst case is the widest number and the longest plan name.
  const wide = shareFacts({
    ...payload,
    total: 987_654.32,
    billing: {
      ...payload.billing,
      plan: { id: 'team', name: 'Team (per seat)', monthly: 30 },
      months: 144,
      subscriptionCost: 432_000,
      ratio: 2.2862,
    },
    meta: { ...payload.meta, sessions: 999_999, workspaces: 4321 },
  });

  for (const f of [shareFacts(payload), wide]) {
    const text = shareText(f, { tone: 'short' });
    assert.ok(text.length <= 280, `${text.length} chars:\n${text}`);
    assert.ok(text.includes('github.com/berenyibence/real-cost-of-agent'), text);
  }
});

test('every platform link points where it claims to, and carries the post in it', () => {
  const f = shareFacts(payload);
  const targets = shareTargets(f);
  const byId = Object.fromEntries(targets.map((t) => [t.id, t]));

  const hosts = {
    x: 'x.com',
    bluesky: 'bsky.app',
    linkedin: 'www.linkedin.com',
    threads: 'www.threads.net',
    reddit: 'www.reddit.com',
    hackernews: 'news.ycombinator.com',
    facebook: 'www.facebook.com',
  };

  for (const [id, host] of Object.entries(hosts)) {
    const url = new URL(byId[id].href);
    assert.equal(url.protocol, 'https:', `${id} must be https`);
    assert.equal(url.host, host, `${id} points at ${url.host}`);
  }

  // Prefilled means the text survives the round trip through the query string.
  assert.equal(new URL(byId.x.href).searchParams.get('text'), shareText(f, { tone: 'short' }));
  assert.equal(new URL(byId.linkedin.href).searchParams.get('text'), shareText(f, { tone: 'long' }));
  assert.equal(new URL(byId.reddit.href).searchParams.get('title'), redditTitle(f));
  assert.equal(new URL(byId.hackernews.href).searchParams.get('u'), REPO_URL);

  // The two that cannot prefill must say so, so the UI can tell the truth.
  assert.equal(byId.facebook.prefills, false);
  assert.equal(byId.instagram.prefills, false);
  assert.equal(byId.instagram.href, null);
  for (const t of targets) {
    if (!t.prefills) assert.ok(t.note, `${t.id} cannot prefill and must explain why`);
  }
});

test('an edited post is what actually gets shared', () => {
  // The box is editable, and a button that quietly posts the generated text
  // instead is worse than no box at all.
  const f = shareFacts(payload);
  const mine = 'I rewrote this myself. https://example.com';
  const targets = shareTargets(f, { short: mine, long: mine });
  assert.equal(new URL(targets.find((t) => t.id === 'x').href).searchParams.get('text'), mine);
  assert.equal(
    new URL(targets.find((t) => t.id === 'linkedin').href).searchParams.get('text'),
    mine,
  );
});

test('an empty machine has nothing to share, and is not offered the option', () => {
  assert.equal(shareable({ total: 0, meta: { found: false } }), false);
  assert.equal(shareable({ total: 0, meta: { found: true } }), false);
  assert.equal(shareable({ total: 12, meta: { found: true } }), true);
  assert.equal(shareable(null), false);
  assert.equal(shareable(undefined), false);
});

test('a malformed payload produces finite numbers rather than $NaN', () => {
  // The page renders this straight into an image; `$NaN` shipped to LinkedIn is
  // not recoverable the way a broken table cell is.
  const f = shareFacts({ total: 'not a number', billing: {}, meta: {}, components: null });
  for (const [key, value] of Object.entries(f)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} is ${value}`);
  }
  assert.equal(f.months >= 1, true);
  assert.deepEqual(f.split, []);
  assert.equal(shareText(f, { tone: 'short' }).includes('NaN'), false);
  assert.equal(shareText(f, { tone: 'long' }).includes('NaN'), false);
});

test('money in a post is written out, not abbreviated into someone else‘s rounding', () => {
  assert.equal(dollars(1284.42), '$1,284');
  assert.equal(dollars(12_480), '$12,480');
  assert.equal(dollars(4.2), '$4.20');
  assert.equal(dollars(0), '$0');
  assert.equal(dollars(-5), '$0');
  assert.equal(dollars(NaN), '$0');
});

test('the image formats cover the platforms the buttons offer', () => {
  const ids = FORMATS.map((f) => f.id);
  assert.deepEqual(ids, ['landscape', 'portrait', 'square']);
  for (const f of FORMATS) {
    assert.ok(f.w > 0 && f.h > 0, f.id);
    assert.ok(f.note, `${f.id} should say which platforms it is for`);
  }
  // 1200×630 is the one crop X, LinkedIn and Facebook all accept uncropped.
  const landscape = FORMATS[0];
  assert.equal(landscape.w, 1200);
  assert.equal(landscape.h, 630);
});
