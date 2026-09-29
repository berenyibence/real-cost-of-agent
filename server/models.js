/**
 * Model catalog — the basis for every cost, limit and context number in the UI.
 *
 * Rates are USD per million tokens, as published for the first-party Anthropic
 * API. Partner platforms (Bedrock, Vertex) price separately and are not modelled
 * here; a session run through one of those is labelled as an estimate.
 *
 * Cache economics:
 *   read       0.1x  the model's input rate — except where an entry carries its
 *                    own `cacheRead` (0.05x Opus 5.5, 0.025x Fable/Mythos 5.1)
 *   write 5m   1.25x
 *   write 1h   2x
 * Transcripts record the 5m/1h split per request, so cost is computed exactly
 * rather than assumed.
 *
 * The model is not the whole rate, though: fast mode and US-pinned inference
 * both move it, both are recorded per request, and both are read here rather
 * than assumed away. See `requestRates`.
 */

/**
 * Rates in $/MTok. `promo.until` marks promotional pricing with an end date.
 * `fastInput`/`fastOutput` are the published fast-mode rates, on the three
 * models that have them. `cacheRead` is the cache-hit multiplier, on the models
 * that publish one other than 0.1x.
 *
 * No entry carries a `promo` today — Sonnet 5's introductory rate became its
 * standard rate — but the mechanism stays, because the rule it enforces does: a
 * promotion is an offer on one named model for one stated period, and
 * `lookupModel` must never extend it to an id nobody has published a price for.
 *
 * Verified against the published rate card on 2026-09-30, including the
 * per-model cache columns.
 */
const CATALOG = {
  'claude-fable-5-1': {
    name: 'Fable 5.1',
    tier: 'fable',
    input: 10,
    output: 50,
    /**
     * Same base rate as Fable 5, but a cache hit is 0.025x input — $0.25/MTok
     * against Fable 5's $1. Claude Code sessions are mostly cache reads, so
     * pricing these at the old 0.1x would overstate a Fable 5.1 session several
     * times over while every column still summed perfectly.
     */
    cacheRead: 0.025,
    context: 1_000_000,
    maxOutput: 128_000,
  },
  'claude-mythos-5-1': {
    name: 'Mythos 5.1',
    tier: 'fable',
    input: 10,
    output: 50,
    cacheRead: 0.025,
    context: 1_000_000,
    maxOutput: 128_000,
  },
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
  'claude-opus-5-5': {
    name: 'Opus 5.5',
    tier: 'opus',
    // Cheaper than Opus 5 on every column, and as the first Opus entry it is
    // also what an unrecognised Opus id is now priced at.
    input: 4,
    output: 20,
    // 0.05x input: $0.20/MTok, not the $0.40 a 0.1x multiplier would give.
    cacheRead: 0.05,
    // Double the standard rate, as on Opus 5 — but double of $4/$20.
    fastInput: 8,
    fastOutput: 40,
    context: 1_000_000,
    maxOutput: 128_000,
  },
  'claude-opus-5': {
    name: 'Opus 5',
    tier: 'opus',
    input: 5,
    output: 25,
    /**
     * Fast mode is the same model served at up to 2.5x the output speed, and it
     * is billed at its own published rate rather than as a multiplier on the
     * standard one — $10/$50, exactly double. Claude Code exposes it as `/fast`
     * and records `speed: "fast"` on every request that used it, so this is
     * measured; pricing those requests off the standard column halves them.
     */
    fastInput: 10,
    fastOutput: 50,
    context: 1_000_000,
    maxOutput: 128_000,
  },
  'claude-opus-4-8': {
    name: 'Opus 4.8',
    tier: 'opus',
    input: 5,
    output: 25,
    // Also has published fast-mode pricing. Opus 4.7 had it
    // withdrawn and Opus 4.6 never had it, so neither carries these.
    fastInput: 10,
    fastOutput: 50,
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
  'claude-sonnet-5-5': {
    name: 'Sonnet 5.5',
    tier: 'sonnet',
    input: 2,
    output: 10,
    context: 1_000_000,
    maxOutput: 128_000,
  },
  'claude-sonnet-5': {
    name: 'Sonnet 5',
    tier: 'sonnet',
    /**
     * $2/$10 is the **standard** rate, not a promotion.
     *
     * It launched as introductory pricing through 2026-08-31, and this entry
     * modelled it that way — `input: 3, output: 15` with a `promo` overriding
     * it until the window closed. Anthropic then cancelled the scheduled rise
     * and made $2/$10 permanent, which left two faults here: every Sonnet 5
     * session would have silently repriced **50% higher on 2026-09-01** with
     * nothing on the page to explain the jump, and until then any unrecognised
     * Sonnet id was already being priced at the withdrawn $3/$15, because an
     * inferred rate is the list rate and the list rate was the wrong number.
     *
     * The published cache columns confirm the base independently: Sonnet 5's
     * cache hit is $0.20/MTok, which is 0.1x of $2 — at $3 it would be $0.30.
     */
    input: 2,
    output: 10,
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
  // Retired on the first-party API and still published at $0.80/$4, so a
  // transcript that used it can be priced exactly rather than inferred. Without
  // this entry the id falls to the tier default and is charged at Haiku 4.5's
  // $1/$5 — 25% over, flagged `inferred`, but wrong when the real rate is known.
  // Note the old id order: `claude-3-5-haiku`, not `claude-haiku-3-5`.
  'claude-3-5-haiku': {
    name: 'Haiku 3.5',
    tier: 'haiku',
    input: 0.8,
    output: 4,
    context: 200_000,
    maxOutput: 8_192,
    legacy: true,
  },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

/**
 * Pinning inference to the US costs 1.1x on **every** token category — input,
 * output, cache writes and cache reads alike. Claude 4.6 and later only; earlier
 * models reject the parameter, so it cannot appear on one of their requests.
 */
const GEO_US_MULTIPLIER = 1.1;

/**
 * Server-side web search: $10 per 1,000 searches, on top of the tokens the
 * results turn into. The only charge in this app that a token count cannot see —
 * it arrives as a request count in `server_tool_use`, and a total built purely
 * from tokens omits it silently.
 */
const WEB_SEARCH_RATE = 10 / 1_000;

/**
 * Strip a date suffix (`claude-haiku-4-5-20251001`) down to the catalog key.
 *
 * `String(model)` rather than `model`, because this is fed ids that came out of
 * JSON another program wrote. A transcript recording `"model": 12345` — a proxy
 * or a gateway is free to put anything in that field — reached `.replace` on a
 * number and threw, and the throw did not stay local: `withEconomics` is mapped
 * over every session outside the scanner's per-transcript `try`, so one
 * malformed id anywhere on disk emptied the entire index and the page showed
 * nothing at all. `inferTier` below has always coerced; this did not, and the
 * inconsistency was the bug.
 *
 * A value that coerces to nothing usable simply fails to match, which lands it
 * in `unpriced` where invariant 5 says an unpriceable id belongs.
 */
function normalise(model) {
  if (!model) return null;
  const bare = String(model).replace(/^anthropic\./, '');
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
    /**
     * Null on every model without published fast-mode pricing, which is most of
     * them. An inferred spec inherits its tier default's fast rates on purpose:
     * fast mode is a premium, not a promotion, and declining to apply it to an
     * unrecognised id would under-price a request that says it ran fast.
     */
    fastInputRate: entry.fastInput ?? null,
    fastOutputRate: entry.fastOutput ?? null,
    /**
     * What a cache hit costs as a fraction of input. 0.1x everywhere until Opus
     * 5.5 and Fable 5.1 published their own; an inferred spec inherits its tier
     * default's, for the same reason it inherits the base rate — it is that
     * model's list price, not an offer.
     */
    cacheReadMultiplier: entry.cacheRead ?? CACHE_READ_MULTIPLIER,
    promoUntil: promoActive ? entry.promo.until : null,
  };
}

/**
 * The rates one request is billed at, in dollars per token.
 *
 * The catalog gives the rate for a model; two things recorded on the request
 * itself move it, and both were previously read past:
 *
 * **`speed: "fast"`** bills at the model's fast-mode rate — $8/$40 on Opus 5.5,
 * $10/$50 on Opus 5 and Opus 4.8, double the standard card in each case. On a model with no published fast rate
 * the flag changes nothing, which is also what the API does (Opus 4.6 runs such
 * a request at standard speed and bills it at standard rates).
 *
 * That literal is verified, not guessed: Claude Code's own request builder reads
 * `t.speed === "fast" && { speed: "fast" }`, and the usage block it writes
 * carries `speed: "standard"` on all 21,383 priced requests in the index here.
 *
 * **`inference_geo: "us"`** bills at 1.1x across every category, cache included.
 * This one is weaker evidence and worth knowing about: `"us"` is the value the
 * published pricing page names, but Claude Code validates the field as a plain
 * nullable string and passes through whatever the API returned, and no request
 * on this machine has ever been pinned — they all record `not_available`. So the
 * multiplier is documented fact while the spelling that triggers it is not
 * observed. If a pinned response turns out to say something else, this is the
 * line to change; until then the check can only fire on the documented value,
 * and anything that is not `"us"` is standard.
 *
 * Deliberately not modelled: `service_tier`. Batch is 50% off and priority
 * publishes no multiplier at all, and neither can reach a Claude Code
 * transcript — every request in the real index here is `standard`. Reading an
 * unrecognised tier as standard can only ever overstate, which is the direction
 * this app errs in by choice.
 */
export function requestRates(model, usage = {}) {
  const spec = lookupModel(model);
  if (!spec) return null;
  const fast = usage.speed === 'fast' && spec.fastInputRate != null;
  const geo = usage.inferenceGeo === 'us' ? GEO_US_MULTIPLIER : 1;
  const input = ((fast ? spec.fastInputRate : spec.inputRate) / 1_000_000) * geo;
  return {
    spec,
    /** True only when the request ran fast *and* the model prices it. */
    fast,
    geoMultiplier: geo,
    input,
    output: ((fast ? spec.fastOutputRate : spec.outputRate) / 1_000_000) * geo,
    /**
     * Per search rather than per token, and no geo multiplier: the 1.1x is
     * published for token categories, and a search is not one.
     */
    webSearch: WEB_SEARCH_RATE,
    /** A cache hit's fraction of `input` — per model, no longer a constant. */
    cacheReadMultiplier: spec.cacheReadMultiplier,
  };
}

/**
 * Cost in USD for one request's usage block, or for a slice of requests that
 * share a model and the same billing terms.
 *
 * `cacheWrite5m`/`cacheWrite1h` come from the transcript's `cache_creation`
 * split; when only a total is known, it is billed at the 5m rate. `speed` and
 * `inferenceGeo` are read off the same usage — see `requestRates`.
 */
export function costOf(model, usage) {
  const rates = requestRates(model, usage);
  if (!rates) return null;
  return (
    (usage.inputTokens ?? 0) * rates.input +
    (usage.outputTokens ?? 0) * rates.output +
    (usage.cacheReadTokens ?? 0) * rates.input * rates.cacheReadMultiplier +
    (usage.cacheWrite5m ?? 0) * rates.input * CACHE_WRITE_5M_MULTIPLIER +
    (usage.cacheWrite1h ?? 0) * rates.input * CACHE_WRITE_1H_MULTIPLIER +
    (usage.webSearchRequests ?? 0) * rates.webSearch
  );
}

/**
 * What the same work would have cost with no cache hits — the counterfactual
 * that makes the caching saving legible.
 *
 * Web search is charged here too, at the same figure. Caching has nothing to do
 * with what a search costs, so carrying it on both sides keeps `saved` the
 * caching delta and nothing else.
 */
export function uncachedCostOf(model, usage) {
  const rates = requestRates(model, usage);
  if (!rates) return null;
  const allInput =
    (usage.inputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWrite5m ?? 0) +
    (usage.cacheWrite1h ?? 0);
  return (
    allInput * rates.input +
    (usage.outputTokens ?? 0) * rates.output +
    (usage.webSearchRequests ?? 0) * rates.webSearch
  );
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
export {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  GEO_US_MULTIPLIER,
  WEB_SEARCH_RATE,
};
