/**
 * Model catalog — the basis for every cost, limit and context number in the UI.
 *
 * Rates are USD per million tokens, as published for the first-party Anthropic
 * API. Partner platforms (Bedrock, Vertex) price separately and are not modelled
 * here; a session run through one of those is labelled as an estimate.
 *
 * Cache economics (same for every model):
 *   read       0.1x  the model's input rate
 *   write 5m   1.25x
 *   write 1h   2x
 * Transcripts record the 5m/1h split per request, so cost is computed exactly
 * rather than assumed.
 */

/** Rates in $/MTok. `until` marks promotional pricing with an end date. */
const CATALOG = {
  'claude-fable-5': {
    name: 'Fable 5',
    tier: 'fable',
    input: 10,
    output: 50,
    context: 1_000_000,
    maxOutput: 128_000,
  },
  'claude-mythos-5': {
    name: 'Mythos 5',
    tier: 'fable',
    input: 10,
    output: 50,
    context: 1_000_000,
    maxOutput: 128_000,
  },
  'claude-opus-5': {
    name: 'Opus 5',
    tier: 'opus',
    input: 5,
    output: 25,
    context: 1_000_000,
    maxOutput: 128_000,
  },
  'claude-opus-4-8': {
    name: 'Opus 4.8',
    tier: 'opus',
    input: 5,
    output: 25,
    context: 1_000_000,
    maxOutput: 128_000,
  },
  'claude-opus-4-7': {
    name: 'Opus 4.7',
    tier: 'opus',
    input: 5,
    output: 25,
    context: 1_000_000,
    maxOutput: 128_000,
  },
  'claude-opus-4-6': {
    name: 'Opus 4.6',
    tier: 'opus',
    input: 5,
    output: 25,
    context: 1_000_000,
    maxOutput: 128_000,
  },
  'claude-opus-4-5': {
    name: 'Opus 4.5',
    tier: 'opus',
    input: 5,
    output: 25,
    context: 200_000,
    maxOutput: 64_000,
    legacy: true,
  },
  'claude-opus-4-1': {
    name: 'Opus 4.1',
    tier: 'opus',
    input: 15,
    output: 75,
    context: 200_000,
    maxOutput: 32_000,
    legacy: true,
  },
  'claude-opus-4-0': {
    name: 'Opus 4',
    tier: 'opus',
    input: 15,
    output: 75,
    context: 200_000,
    maxOutput: 32_000,
    legacy: true,
  },
  'claude-sonnet-5': {
    name: 'Sonnet 5',
    tier: 'sonnet',
    input: 3,
    output: 15,
    // Introductory pricing runs through 2026-08-31.
    promo: { input: 2, output: 10, until: '2026-08-31' },
    context: 1_000_000,
    maxOutput: 128_000,
  },
  'claude-sonnet-4-6': {
    name: 'Sonnet 4.6',
    tier: 'sonnet',
    input: 3,
    output: 15,
    context: 1_000_000,
    maxOutput: 128_000,
  },
  'claude-sonnet-4-5': {
    name: 'Sonnet 4.5',
    tier: 'sonnet',
    input: 3,
    output: 15,
    context: 200_000,
    maxOutput: 64_000,
    legacy: true,
  },
  'claude-sonnet-4-0': {
    name: 'Sonnet 4',
    tier: 'sonnet',
    input: 3,
    output: 15,
    context: 200_000,
    maxOutput: 64_000,
    legacy: true,
  },
  'claude-haiku-4-5': {
    name: 'Haiku 4.5',
    tier: 'haiku',
    input: 1,
    output: 5,
    context: 200_000,
    maxOutput: 64_000,
  },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

/** Strip a date suffix (`claude-haiku-4-5-20251001`) down to the catalog key. */
function normalise(model) {
  if (!model) return null;
  const bare = model.replace(/^anthropic\./, '');
  if (CATALOG[bare]) return bare;
  const undated = bare.replace(/-\d{8}$/, '');
  return CATALOG[undated] ? undated : null;
}

/**
 * The newest catalog entry for each tier, which is what an unrecognised member
 * of that tier is priced at.
 *
 * Built rather than written down, so adding a model to the catalog updates this
 * automatically. "Newest" is the first non-legacy entry, because the catalog is
 * already ordered newest-first within a tier and legacy rows are kept only to
 * price old sessions.
 */
const TIER_DEFAULT = (() => {
  const byTier = new Map();
  for (const [key, entry] of Object.entries(CATALOG)) {
    if (entry.legacy || byTier.has(entry.tier)) continue;
    byTier.set(entry.tier, key);
  }
  return byTier;
})();

/**
 * The tier an unknown model id is claiming to be, or null.
 *
 * This exists because the catalog is maintained by hand and models ship without
 * asking it. Before this, an id it had never seen produced `null` all the way
 * up: `withEconomics` set `economics` to null, `spendBreakdown` skipped the
 * session outright, and `statsOf` counted it as **$0**. Nothing said so. The
 * first day a new Claude model shipped, every total in this app would quietly
 * drop by however much work had moved to it — an error in the flattering
 * direction, in the one view whose entire job is "where every dollar went".
 *
 * Only the tier word is trusted, and only in an id shaped like Anthropic's.
 * `claude-sonnet-4-7` is a Sonnet by any reading; `gpt-4o` and `unknown` say
 * nothing this can honestly act on and stay unpriced rather than guessed at.
 */
function inferTier(model) {
  if (!model) return null;
  const bare = String(model)
    .replace(/^anthropic\./, '')
    .toLowerCase();
  if (!bare.startsWith('claude-')) return null;
  for (const tier of TIER_DEFAULT.keys()) {
    // Bounded by a separator so `claude-opus-5` matches `opus` but a future
    // `claude-opusculum-1` does not.
    if (new RegExp(`(^|-)${tier}(-|$)`).test(bare)) return tier;
  }
  return null;
}

/**
 * What a model costs and how much it can hold.
 *
 * Returns `null` only when the id says nothing usable. An id that names a known
 * tier is priced at that tier's **list** rates and flagged `inferred`, because a
 * rate that is probably right and labelled as a guess is worth far more than a
 * confident zero — and every caller can now tell the two apart.
 *
 * List rather than promotional, and that distinction is the whole care here. A
 * promotion is an offer on one named model for one stated period; extending it
 * to an id nobody has published a price for would be inventing a discount, and
 * inventing discounts is how this function came to be rewritten.
 */
export function lookupModel(model) {
  const key = normalise(model) ?? TIER_DEFAULT.get(inferTier(model));
  if (!key) return null;
  const inferred = !normalise(model);
  const entry = CATALOG[key];
  const promoActive =
    !inferred && entry.promo && new Date() <= new Date(`${entry.promo.until}T23:59:59Z`);
  return {
    id: key,
    // The id that was actually asked about, so a caller showing an inferred
    // model names the thing that ran rather than the one it was priced as.
    requested: model ?? key,
    name: inferred ? `${model} (priced as ${entry.name})` : entry.name,
    /** True when the catalog had never heard of this id and a tier was assumed. */
    inferred,
    tier: entry.tier,
    context: entry.context,
    maxOutput: entry.maxOutput,
    legacy: !!entry.legacy,
    inputRate: promoActive ? entry.promo.input : entry.input,
    outputRate: promoActive ? entry.promo.output : entry.output,
    listInputRate: entry.input,
    listOutputRate: entry.output,
    promoUntil: promoActive ? entry.promo.until : null,
  };
}

/**
 * Cost in USD for one request's usage block.
 * `cacheWrite5m`/`cacheWrite1h` come from the transcript's `cache_creation`
 * split; when only a total is known, it is billed at the 5m rate.
 */
export function costOf(model, usage) {
  const spec = lookupModel(model);
  if (!spec) return null;
  const inRate = spec.inputRate / 1_000_000;
  const outRate = spec.outputRate / 1_000_000;
  return (
    (usage.inputTokens ?? 0) * inRate +
    (usage.outputTokens ?? 0) * outRate +
    (usage.cacheReadTokens ?? 0) * inRate * CACHE_READ_MULTIPLIER +
    (usage.cacheWrite5m ?? 0) * inRate * CACHE_WRITE_5M_MULTIPLIER +
    (usage.cacheWrite1h ?? 0) * inRate * CACHE_WRITE_1H_MULTIPLIER
  );
}

/**
 * What the same work would have cost with no cache hits — the counterfactual
 * that makes the caching saving legible.
 */
export function uncachedCostOf(model, usage) {
  const spec = lookupModel(model);
  if (!spec) return null;
  const inRate = spec.inputRate / 1_000_000;
  const outRate = spec.outputRate / 1_000_000;
  const allInput =
    (usage.inputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWrite5m ?? 0) +
    (usage.cacheWrite1h ?? 0);
  return allInput * inRate + (usage.outputTokens ?? 0) * outRate;
}

/** How close a request came to filling the model's context window. */
export function contextPressure(model, peakInputTokens) {
  const spec = lookupModel(model);
  if (!spec || !peakInputTokens) return null;
  return {
    peak: peakInputTokens,
    window: spec.context,
    ratio: Math.min(1, peakInputTokens / spec.context),
  };
}

export const MODEL_IDS = Object.keys(CATALOG);
export { CACHE_READ_MULTIPLIER, CACHE_WRITE_5M_MULTIPLIER, CACHE_WRITE_1H_MULTIPLIER };
