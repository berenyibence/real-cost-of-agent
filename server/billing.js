/**
 * Subscription versus API billing.
 *
 * Two different meters can produce the same tokens:
 *   - A **subscription** (Pro / Max) is authenticated over OAuth. Usage draws
 *     against plan limits and spends **no API credits**. The token cost this app
 *     computes is what the same work *would* have cost on the API — the value
 *     you are getting, not a charge you incurred.
 *   - **API billing** is authenticated with a key and bills per token. There the
 *     computed cost is the real charge.
 *
 * Which one is in play is detectable: Claude Code records its beta set in local
 * telemetry, and `oauth-2025-04-20` means subscription auth. What is *not* on
 * disk anywhere is the plan tier or its price, so those are the user's to set —
 * defaults are provided and are editable rather than asserted as current.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_DIR } from './scan.js';
import { CONFIG_DIR } from './paths.js';

const TELEMETRY_DIR = path.join(CLAUDE_DIR, 'telemetry');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Default monthly prices, in USD. These are starting points the user can edit —
 * published pricing changes, and this app should never quietly show a stale
 * number as fact.
 */
export const PLANS = [
  { id: 'none', name: 'No subscription', monthly: 0, note: 'Billing straight to API credits.' },
  { id: 'pro', name: 'Claude Pro', monthly: 20, note: 'Individual plan.' },
  { id: 'max5', name: 'Claude Max 5×', monthly: 100, note: 'Higher limits than Pro.' },
  { id: 'max20', name: 'Claude Max 20×', monthly: 200, note: 'Highest individual limits.' },
  { id: 'team', name: 'Team (per seat)', monthly: 30, note: 'Per-seat business plan.' },
  { id: 'custom', name: 'Custom', monthly: 0, note: 'Set your own monthly figure.' },
];

const DEFAULT_CONFIG = {
  planId: 'max20',
  monthlyOverride: null,
  seats: 1,
};

/**
 * Force a config into a shape the arithmetic downstream can survive.
 *
 * Applied on the way in *and* on the way out, because there are two ways
 * nonsense arrives: a request body, and a file on disk that someone edited by
 * hand. Neither failure is loud on its own — an unknown `planId` falls through
 * to the $0 plan and reads as "no subscription", which is a claim rather than a
 * blank, and a `monthlyOverride` of `"abc"` becomes `NaN`, which propagates
 * through every comparison on the page as an empty figure.
 *
 * Bad values are dropped for the default rather than rejected. This is a
 * preference, not a transaction: the useful behaviour when the stored plan no
 * longer exists is to show a sensible one, not to break the page.
 */
export function sanitizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== 'object') return config;

  if (PLANS.some((p) => p.id === raw.planId)) config.planId = raw.planId;

  // Explicit null means "use the plan's own price", which is different from an
  // unparseable value and has to survive.
  if (raw.monthlyOverride != null) {
    const monthly = Number(raw.monthlyOverride);
    if (Number.isFinite(monthly) && monthly >= 0) config.monthlyOverride = monthly;
  }

  const seats = Number(raw.seats);
  if (Number.isFinite(seats) && seats >= 1) config.seats = Math.floor(seats);

  return config;
}

export function readConfig() {
  try {
    return sanitizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * What the config becomes when a patch lands on it.
 *
 * `undefined` means "not in this patch" and is dropped before the merge. A
 * plain spread does not make that distinction, and the endpoint names every
 * field on every request — so a request that only meant to change the plan
 * would also blank the seat count back to its default.
 *
 * `null` is left alone: `monthlyOverride: null` is a real value meaning "use
 * the plan's own price", and is not the same as declining to say.
 *
 * Pure, and separate from the write, so the rule can be tested without a real
 * path under `~/.config`.
 */
export function mergeConfig(current, patch) {
  const given = Object.fromEntries(
    Object.entries(patch ?? {}).filter(([, value]) => value !== undefined),
  );
  return sanitizeConfig({ ...current, ...given });
}

export async function writeConfig(patch) {
  const next = mergeConfig(readConfig(), patch);
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** The effective monthly price for the selected plan. */
export function planPrice(config = readConfig()) {
  const plan = PLANS.find((p) => p.id === config.planId) ?? PLANS[0];
  const base = config.monthlyOverride != null ? Number(config.monthlyOverride) : plan.monthly;
  return { plan, monthly: base * (config.seats || 1) };
}

/* ------------------------------------------------------------------ *
 * Auth-mode detection
 * ------------------------------------------------------------------ */

let authCache = null;

/**
 * Read local telemetry to work out how Claude Code is authenticating.
 * Cached — this reads a few hundred KB and the answer does not change often.
 */
export function detectAuth({ refresh = false } = {}) {
  if (authCache && !refresh) return authCache;

  const result = {
    mode: 'unknown',
    evidence: null,
    sampled: 0,
  };

  try {
    const files = fs.readdirSync(TELEMETRY_DIR).filter((f) => f.endsWith('.json'));
    let oauth = 0;
    let apiKey = 0;
    for (const name of files.slice(0, 60)) {
      let text;
      try {
        text = fs.readFileSync(path.join(TELEMETRY_DIR, name), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim().replace(/,$/, '');
        if (!trimmed.startsWith('{')) continue;
        let evt;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const data = evt.event_data ?? {};
        if (typeof data.betas === 'string') {
          result.sampled += 1;
          if (data.betas.includes('oauth-')) oauth += 1;
          else apiKey += 1;
        }
      }
    }
    if (oauth > 0 && oauth >= apiKey) {
      result.mode = 'subscription';
      result.evidence = `oauth beta present in ${oauth} of ${result.sampled} sampled telemetry events`;
    } else if (apiKey > 0) {
      result.mode = 'api';
      result.evidence = `no oauth beta in ${apiKey} sampled telemetry events`;
    }
  } catch {
    /* no telemetry on disk — mode stays unknown */
  }

  authCache = result;
  return result;
}

/* ------------------------------------------------------------------ *
 * The comparison
 * ------------------------------------------------------------------ */

/**
 * Compare what the indexed usage would cost on the API against what the
 * subscription actually costs over the same period.
 *
 * `apiEquivalent` is the token cost already computed from real usage.
 * `firstAt`/`lastAt` bound the period so the subscription is charged for the
 * months the work actually spans, not a flat month.
 */
export function compareBilling({ apiEquivalent, firstAt, lastAt, config = readConfig() }) {
  const { plan, monthly } = planPrice(config);
  const auth = detectAuth();

  const spanMs = Math.max(0, (lastAt ?? 0) - (firstAt ?? 0));
  const days = spanMs / 86_400_000;
  // Round up to whole months: you pay for a month even if you used four days of it.
  const months = Math.max(1, Math.ceil(days / 30.44));
  const subscriptionCost = monthly * months;

  const onSubscription = auth.mode === 'subscription' && plan.id !== 'none';
  const saved = onSubscription ? apiEquivalent - subscriptionCost : 0;
  const ratio = subscriptionCost > 0 ? apiEquivalent / subscriptionCost : null;

  return {
    authMode: auth.mode,
    authEvidence: auth.evidence,
    plan: { id: plan.id, name: plan.name, note: plan.note, monthly },
    seats: config.seats || 1,
    months,
    days: Math.round(days),
    // What the same tokens would cost on the API.
    apiEquivalent,
    // What the subscription costs over the same span.
    subscriptionCost,
    // Positive means the subscription is cheaper than metered API use.
    saved,
    // "Every $1 of subscription bought $N of API-rate usage."
    ratio,
    // Real API credits consumed. On a subscription this is zero, and saying so
    // plainly is the whole point of this panel.
    apiCreditsSpent: auth.mode === 'api' ? apiEquivalent : 0,
    onSubscription,
  };
}
