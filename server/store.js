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
function priceAcrossModels(session, price) {
  const slices = session.usageByModel;
  if (!Array.isArray(slices) || slices.length === 0) return price(session.model, session.usage);
  let total = 0;
  for (const slice of slices) {
    const part = price(slice.model, slice);
    // An unpriced model would silently drop its slice, which reads as a
    // discount. Fall back to the session's headline model for that slice only.
    total += part ?? price(session.model, slice) ?? 0;
  }
  return total;
}

/**
 * The model a session should be *described* by when it used several: the one
 * that did the most work, not the one that happened to answer last.
 */
function primaryModel(session) {
  const slices = session.usageByModel;
  if (!Array.isArray(slices) || slices.length === 0) return session.model;
  const best = slices.reduce((a, b) => (b.requests > a.requests ? b : a));
  return lookupModel(best.model) ? best.model : session.model;
}

/** Attach what a run cost, and how close it came to filling its context window. */
export function withEconomics(session) {
  const spec = lookupModel(primaryModel(session)) ?? lookupModel(session.model);
  const cost = priceAcrossModels(session, costOf);
  const uncached = priceAcrossModels(session, uncachedCostOf);
  // Every token the model read this session: fresh input, cache reads, and the
  // writes you paid a premium to create. Excluding writes would report ~100%
  // for any cached session and hide the cost of rebuilding the cache.
  const totalInput =
    session.usage.inputTokens + session.usage.cacheReadTokens + session.usage.cacheWriteTokens;
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
        }
      : null,
  };
}

/** @type {{workspaces: any[], sessions: any[], scannedAt: number}} */
let index = { workspaces: [], sessions: [], scannedAt: 0 };
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
    const { workspaces, sessions } = await scan();
    index = {
      workspaces,
      sessions: sessions.map(withEconomics),
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
    refresh().catch((err) => console.error('[agent-spend] rescan failed:', err.message));
  });
}
