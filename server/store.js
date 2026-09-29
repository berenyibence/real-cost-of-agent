/**
 * The in-memory index every request is served from.
 *
 * Scanning re-reads whatever changed and caches the result, so a page load never
 * re-parses hundreds of megabytes of transcripts. Pricing happens here rather
 * than in the scanner: what a session cost is arithmetic over normalized token
 * counts, and keeping it out of the reader is what lets a second agent's
 * transcripts be added later without touching any of it.
 */

import { scan, watch } from './scan.js';
import { contextPressure, costOf, lookupModel, uncachedCostOf } from './models.js';

/**
 * Price a session across every model that served it.
 *
 * A session is not one model — switching mid-run is common, and the tiers differ
 * by up to 2x — so charging the whole token count at whichever model answered
 * last is wrong by however much the mix was. A session that reports a single
 * model still works: the split is then one slice, and the arithmetic is
 * identical.
 */
function priceAcrossModels(session, price, fallbackModel) {
  const slices = session.usageByModel;
  if (!Array.isArray(slices) || slices.length === 0) return price(fallbackModel, session.usage);
  let total = 0;
  for (const slice of slices) {
    const part = price(slice.model, slice);
    // An unpriced model would silently drop its slice, which reads as a
    // discount. Fall back to the session's headline model for that slice only.
    //
    // The fallback is the *resolved* headline model rather than `session.model`,
    // which is whichever id answered last. `componentsOf` decomposes an
    // unpriceable slice at the resolved one, so using the raw id here could
    // price a slice at nothing that the components column priced at something —
    // the two arithmetics disagreeing about the same tokens, which is the one
    // failure every breakdown summing to the total is meant to rule out.
    total += part ?? price(fallbackModel, slice) ?? 0;
  }
  return total;
}

/**
 * The model a session should be *described* by when it used several: the one
 * that did the most work, not the one that happened to answer last.
 *
 * Requests are totalled per model rather than read off the biggest slice: one
 * model can hold several slices when the billing terms changed mid-run (a
 * `/fast` toggle splits it), and the largest single slice is then not the model
 * that did the most work.
 */
function primaryModel(session) {
  const slices = session.usageByModel;
  if (!Array.isArray(slices) || slices.length === 0) return session.model;
  const requestsByModel = new Map();
  for (const { model, requests } of slices) {
    requestsByModel.set(model, (requestsByModel.get(model) ?? 0) + (requests ?? 0));
  }

  /**
   * The busiest model **that can be priced** — not simply the busiest.
   *
   * This used to take the busiest outright and, when the catalog could not
   * price it, fall back to `session.model`, which is whichever id answered
   * last. On a session mixing a gateway id the catalog cannot parse with real
   * Claude work, both of those are the unpriceable id, so `spec` came out null
   * and **the whole session was dropped to `unpriced`** — including every
   * exactly-priceable token in it.
   *
   * What made it a bug rather than a policy was that the outcome depended on
   * nothing meaningful. The same tokens across the same two models priced at
   * $0.00 or $27.51 purely according to which slice happened to hold more
   * requests: busiest-is-unpriceable threw the session away, busiest-is-Opus
   * priced it and folded the unknown slice onto Opus's rate. One of those two
   * answers had to be wrong, and it was decided by request ordering.
   *
   * Choosing the busiest priceable model makes the session priceable whenever
   * any part of it is, which is what `priceAcrossModels` below already assumed.
   * The slices it cannot price are then folded onto this rate — a real guess,
   * and `fallbackPriced` exists so the page can say so rather than present it
   * as a rate card.
   */
  const ranked = [...requestsByModel].sort((a, b) => b[1] - a[1]);
  const priceable = ranked.find(([model]) => lookupModel(model));
  return priceable ? priceable[0] : session.model;
}

/** Attach what a run cost, and how close it came to filling its context window. */
export function withEconomics(session) {
  const spec = lookupModel(primaryModel(session)) ?? lookupModel(session.model);
  const cost = priceAcrossModels(session, costOf, spec?.id ?? session.model);
  const uncached = priceAcrossModels(session, uncachedCostOf, spec?.id ?? session.model);
  // Every token the model read this session: fresh input, cache reads, and the
  // writes you paid a premium to create. Excluding writes would report ~100%
  // for any cached session and hide the cost of rebuilding the cache.
  const totalInput =
    session.usage.inputTokens + session.usage.cacheReadTokens + session.usage.cacheWriteTokens;
  /**
   * At least one slice records a model no rate could be found for, so it was
   * billed here at the session's headline rate instead.
   *
   * Different from `modelSpec.inferred`, which is a model id that named a tier
   * this catalog knows. This is an id that named nothing usable — a gateway
   * route, a proxy's own label — priced at whatever the rest of the session
   * ran on. That is a bigger assumption and it gets its own flag, because
   * "probably right and labelled a guess" is the whole of invariant 5.
   */
  const fallbackPriced =
    Array.isArray(session.usageByModel) &&
    session.usageByModel.length > 0 &&
    session.usageByModel.some((slice) => !lookupModel(slice.model));
  return {
    ...session,
    modelSpec: spec,
    economics: spec
      ? {
          cost,
          uncachedCost: uncached,
          saved: uncached - cost,
          // Share of input the cache served — the single best signal of whether
          // a long session is being run efficiently.
          cacheHitRate: totalInput > 0 ? session.usage.cacheReadTokens / totalInput : 0,
          context: contextPressure(spec.id, session.peakContext),
          mixedModels: Array.isArray(session.usageByModel) && session.usageByModel.length > 1,
          fallbackPriced,
        }
      : null,
  };
}

/** @type {{workspaces: any[], sessions: any[], sources: any[], scannedAt: number}} */
let index = { workspaces: [], sessions: [], sources: [], scannedAt: 0 };
let scanning = null;
let rescanQueued = false;

export function getIndex() {
  return index;
}

export async function refresh() {
  // Collapse overlapping refreshes: a busy agent writes constantly, and the
  // watcher can fire again while the previous scan is still running.
  if (scanning) {
    rescanQueued = true;
    return scanning;
  }
  scanning = (async () => {
    const { workspaces, sessions, sources } = await scan();
    index = {
      workspaces,
      sessions: sessions.map(withEconomics),
      // Passed through untouched: which agents were readable is the scanner's
      // finding, and pricing has no opinion about it.
      sources,
      scannedAt: Date.now(),
    };
    return index;
  })();

  try {
    await scanning;
  } finally {
    scanning = null;
  }
  if (rescanQueued) {
    rescanQueued = false;
    return refresh();
  }
  return index;
}

export function startWatching() {
  return watch(() => {
    refresh().catch((err) => console.error('[real-cost] rescan failed:', err.message));
  });
}
