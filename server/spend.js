/**
 * Where the money went.
 *
 * Total cost is the top of a tree, not the answer. Each level below it splits
 * the same dollars a different way — by what the tokens were (input, output,
 * cache read, cache write), by model, by project, by day, by session — so a
 * number can always be opened until it stops being a mystery.
 *
 * Every figure is derived from recorded token counts at published rates. The
 * multipliers are the ones the API actually bills: cache reads at 0.1x input
 * (0.05x on Opus 5.5, 0.025x on Fable and Mythos 5.1), 5-minute cache writes at
 * 1.25x, 1-hour writes at 2x.
 */

import {
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  WEB_SEARCH_RATE,
  lookupModel,
  requestRates,
} from './models.js';
import { dayKey, eachDay } from './day.js';

/**
 * Every component is `count` of some `unit` at a rate, times a multiplier.
 *
 * The multiplier is a number, or a function of the rates where it differs by
 * model: a cache hit is 0.1x input on most, but 0.05x on Opus 5.5 and 0.025x on
 * Fable 5.1, and a constant here would put this column out of step with the
 * total `costOf` computes.
 *
 * `unit` is `tokens` for all but one of them. Web search is billed per search,
 * and it is here rather than off to one side because the components have to add
 * up to the total — a charge parked outside them would be a charge the page
 * cannot account for.
 */
const COMPONENTS = [
  {
    id: 'output',
    label: 'Output',
    hint: 'Tokens the model generated. The most expensive kind by a wide margin.',
    unit: 'tokens',
    count: (u) => u.outputTokens,
    rate: (r) => r.output,
    multiplier: 1,
  },
  {
    id: 'input',
    label: 'Fresh input',
    hint: 'Prompt tokens read at full price — never cached, or the cache had expired.',
    unit: 'tokens',
    count: (u) => u.inputTokens,
    rate: (r) => r.input,
    multiplier: 1,
  },
  {
    id: 'cacheWrite1h',
    label: 'Cache write (1h)',
    hint: 'Building the 1-hour cache. Billed at double the input rate, and worth it after ~3 reads.',
    unit: 'tokens',
    count: (u) => u.cacheWrite1h,
    rate: (r) => r.input,
    multiplier: CACHE_WRITE_1H_MULTIPLIER,
  },
  {
    id: 'cacheWrite5m',
    label: 'Cache write (5m)',
    hint: 'Building the 5-minute cache. Billed at 1.25x input, and worth it after 2 reads.',
    unit: 'tokens',
    count: (u) => u.cacheWrite5m,
    rate: (r) => r.input,
    multiplier: CACHE_WRITE_5M_MULTIPLIER,
  },
  {
    id: 'cacheRead',
    label: 'Cache read',
    hint:
      'Re-reading a cached prefix at a tenth of the input rate, or less on the newest models. ' +
      'This is where caching pays.',
    unit: 'tokens',
    count: (u) => u.cacheReadTokens,
    rate: (r) => r.input,
    multiplier: (r) => r.cacheReadMultiplier,
  },
  {
    id: 'webSearch',
    label: 'Web search',
    hint:
      'Searches the API ran, at $10 per 1,000. The one charge here that is not a token — ' +
      'the results are billed as input on top of it.',
    unit: 'searches',
    count: (u) => u.webSearchRequests,
    rate: (r) => r.webSearch,
    multiplier: 1,
  },
];

/**
 * Every bucket carries the same token split, whatever it is a bucket of.
 *
 * A model row that shows only a dollar figure and a session count cannot answer
 * the question it invites — *why* is this model the expensive one. Output at 20x
 * the input rate and a cache that is being rebuilt rather than read are two very
 * different answers, and both look identical in a single "tokens" total.
 *
 * The four kinds are kept apart because they are billed at four different
 * multipliers, and searches are counted separately again because they are not
 * tokens at all.
 */
const emptyBucket = () => ({
  cost: 0,
  tokens: 0,
  sessions: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  searches: 0,
});

/**
 * Split one session's spend into its billable components.
 *
 * **Priced per model slice, not per session.** A session is not one model —
 * switching mid-run is common and the tiers differ by up to 2x — so the total
 * is built by pricing each slice at its own rate. This used to charge the whole
 * token count at the session's *primary* model instead, which is the exact
 * mistake the totals were written to avoid: the components then added up to
 * more than the total they were decomposing, by 8.5% on a real index here, and
 * by more the more a session switched.
 *
 * Every other breakdown — by model, by project, by day — already agreed with
 * the total. This one silently did not, which is the worst way for a money
 * number to be wrong: nothing about the view suggested the column was a
 * different arithmetic from the figure above it.
 */
export function componentsOf(session) {
  const spec = session.modelSpec;
  if (!spec) return [];

  // Each slice carries its own usage, its own model, and its own billing terms.
  // A session that reports no split is one slice: the arithmetic below is then
  // identical to the old per-session version, which is why the fix changed
  // nothing for those.
  //
  // The rates come from `requestRates`, not from the catalog entry, so a slice
  // that ran under `/fast` or US-pinned inference is decomposed at the rate it
  // was actually billed at. Reading them off the spec would put the components
  // back out of step with the total, which is the bug this function exists for.
  const slices =
    Array.isArray(session.usageByModel) && session.usageByModel.length
      ? session.usageByModel.map((slice) => ({
          usage: slice,
          rates: requestRates(slice.model, slice) ?? requestRates(spec.id, slice),
        }))
      : [{ usage: session.usage, rates: requestRates(spec.id, session.usage) }];

  const headline = requestRates(spec.id);
  const mult = (c, rates) => (typeof c.multiplier === 'function' ? c.multiplier(rates) : c.multiplier);
  return COMPONENTS.map((c) => {
    let count = 0;
    let cost = 0;
    for (const { usage, rates } of slices) {
      const n = c.count(usage) ?? 0;
      count += n;
      cost += n * c.rate(rates) * mult(c, rates);
    }
    return {
      id: c.id,
      label: c.label,
      hint: c.hint,
      unit: c.unit,
      count,
      multiplier: mult(c, headline),
      /**
       * Dollars per unit — per token, or per search on the one row that is not
       * tokens. The headline rate stays the primary model's standard rate: it is
       * a label for the component, and a figure blended across models, or across
       * a mid-run switch to fast mode, is a number nobody was charged.
       */
      unitCost: c.rate(headline) * mult(c, headline),
      cost,
    };
  });
}

function addInto(map, key, seed, cost, usage) {
  const cur = map.get(key) ?? { ...seed, ...emptyBucket() };
  cur.cost += cost;
  cur.sessions += 1;
  cur.input += usage.inputTokens ?? 0;
  cur.output += usage.outputTokens ?? 0;
  cur.cacheRead += usage.cacheReadTokens ?? 0;
  cur.cacheWrite += usage.cacheWriteTokens ?? 0;
  cur.searches += usage.webSearchRequests ?? 0;
  // Derived rather than accumulated separately, so the total and the split it
  // is a total *of* cannot drift apart.
  cur.tokens = cur.input + cur.output + cur.cacheRead + cur.cacheWrite;
  map.set(key, cur);
}

/**
 * The full breakdown across a set of sessions.
 * `workspaces` supplies display names for project grouping.
 */
export function spendBreakdown(sessions, workspaces = []) {
  const wsName = new Map(workspaces.map((w) => [w.id, w.name]));

  const components = new Map(
    COMPONENTS.map((c) => [
      c.id,
      { id: c.id, label: c.label, hint: c.hint, unit: c.unit, count: 0, cost: 0 },
    ]),
  );
  const byModel = new Map();
  const byProject = new Map();
  const byDay = new Map();

  let total = 0;
  let uncached = 0;
  /**
   * What this total does not include, and what it had to guess at.
   *
   * A figure that silently omits work is the one kind of wrong this view cannot
   * afford — every other number here can be argued with, and this one would not
   * even be visible to argue with. So both caveats travel with the total.
   */
  const unpriced = { sessions: 0, tokens: 0, models: new Set() };
  let inferredCount = 0;
  /** Sessions carrying a slice no rate could be found for, billed at their headline rate. */
  let fallbackCount = 0;

  for (const session of sessions) {
    if (!session.economics || !session.modelSpec) {
      // Counted rather than merely skipped. A session this cannot price still
      // happened and still cost money, and a total that quietly omits it is
      // wrong in the direction nobody checks.
      unpriced.sessions += 1;
      unpriced.tokens +=
        (session.usage?.inputTokens ?? 0) +
        (session.usage?.outputTokens ?? 0) +
        (session.usage?.cacheReadTokens ?? 0) +
        (session.usage?.cacheWriteTokens ?? 0);
      if (session.model) unpriced.models.add(session.model);
      continue;
    }
    if (session.modelSpec.inferred) inferredCount += 1;
    if (session.economics.fallbackPriced) fallbackCount += 1;
    const cost = session.economics.cost ?? 0;
    total += cost;
    uncached += session.economics.uncachedCost ?? 0;

    for (const part of componentsOf(session)) {
      const bucket = components.get(part.id);
      bucket.count += part.count;
      bucket.cost += part.cost;
      // Keep the last seen unit cost for display; it is per-model, so this is
      // indicative rather than exact when several models are mixed.
      bucket.unitCost = part.unitCost;
      bucket.multiplier = part.multiplier;
    }

    addInto(
      byModel,
      session.modelSpec.id,
      { id: session.modelSpec.id, name: session.modelSpec.name, tier: session.modelSpec.tier },
      cost,
      session.usage,
    );
    addInto(
      byProject,
      session.workspaceId,
      {
        id: session.workspaceId,
        name: wsName.get(session.workspaceId) ?? session.workspaceId,
        path: session.cwd,
      },
      cost,
      session.usage,
    );
    // The user's calendar day, not UTC's — otherwise an evening session east of
    // Greenwich is filed under tomorrow.
    const day = dayKey(session.endedAt || Date.now());
    addInto(byDay, day, { id: day, date: day }, cost, session.usage);
  }

  const sortByCost = (a, b) => b.cost - a.cost;
  const withShare = (rows) => rows.map((r) => ({ ...r, share: total > 0 ? r.cost / total : 0 }));

  /**
   * A day you did not work is still a day.
   *
   * `byDay` only has keys for days something ran, so drawing one bar per entry
   * puts a fortnight's gap and an overnight gap side by side at the same width.
   * The idle days are the shape of the data — a week off is the most visible
   * thing in a spend chart, and omitting the empty columns is what hides it.
   *
   * The filled rows cost zero, so every breakdown still sums to the total.
   */
  const dayRows = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  /**
   * The filler is added **around** the real buckets, never mapped over instead
   * of them.
   *
   * This used to build the list by walking `eachDay(first, last)` and looking
   * each date up — which quietly made the day axis the authority on which days
   * existed. `eachDay` stops after `MAX_SPAN_DAYS`, so any real bucket past the
   * cap was dropped: one transcript carrying a future timestamp (a skewed
   * clock, or a file copied from a machine that had one) put the last day
   * eleven years out, and **71% of the money disappeared from this cut** in a
   * test — under a heading promising a breakdown, with every other cut still
   * agreeing with the total. Invariant 1, failing exactly the way `topSessions`
   * used to.
   *
   * Starting from the buckets and filling the gaps makes that unrepresentable:
   * a day with cost is in this list because it is in `byDay`, whatever the fill
   * does or does not manage to cover.
   */
  const days = new Map(dayRows.map((r) => [r.date, r]));
  if (dayRows.length) {
    for (const date of eachDay(dayRows[0].date, dayRows[dayRows.length - 1].date)) {
      if (!days.has(date)) days.set(date, { id: date, date, ...emptyBucket() });
    }
  }
  const filledDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    total,
    uncached,
    saved: uncached - total,
    /** Work this total leaves out, because no rate could be found for it. */
    unpriced: {
      sessions: unpriced.sessions,
      tokens: unpriced.tokens,
      models: [...unpriced.models],
    },
    /** Sessions priced at their tier's rate because the exact id was unknown. */
    inferredSessions: inferredCount,
    /**
     * Sessions where some slice named a model nothing could price, and was
     * billed at the rest of the session's rate instead.
     *
     * A separate count from `inferredSessions` because it is a bigger
     * assumption: that one guessed a rate from a tier the id actually named,
     * this one has no tier to go on and borrows a rate from elsewhere in the
     * same session.
     */
    fallbackPricedSessions: fallbackCount,
    components: withShare([...components.values()].sort(sortByCost)),
    byModel: withShare([...byModel.values()].sort(sortByCost)),
    byProject: withShare([...byProject.values()].sort(sortByCost)),
    byDay: filledDays,
    /**
     * Every priced session, not the loudest twelve.
     *
     * This was `topSessions`, capped at 12 rows. That cap made it the one cut on
     * this payload that did **not** sum to the total — the other four re-split
     * every dollar, and this one showed a fraction of them under the same
     * heading, with nothing on screen to say which fraction. On the index this
     * was written against, twelve rows was 14% of the sessions and 43% of the
     * money: the remaining $1.4k simply had no row anywhere in the app.
     *
     * A cut that quietly answers a smaller question than the one its heading
     * asks is invariant 1 failing silently, which is the failure mode this
     * project exists to catch. So the list is complete, it sums to `total` like
     * every other cut, and `test/spend.test.js` now holds it to that.
     *
     * Each row also carries the four token kinds separately. The token counts
     * are the measured quantity every dollar here is derived from, and a row
     * that prints a cost while withholding what it was computed from is asking
     * to be trusted rather than checked.
     */
    bySession: withShare(
      sessions
        .filter((s) => s.economics)
        .sort((a, b) => b.economics.cost - a.economics.cost)
        .map((s) => ({
          id: s.id,
          name: s.title,
          project: wsName.get(s.workspaceId) ?? s.workspaceId,
          model: s.modelSpec?.name,
          /** More than one billing slice — a mid-run model or `/fast` switch. */
          models: Array.isArray(s.usageByModel) ? s.usageByModel.length : 1,
          inferred: s.modelSpec?.inferred === true,
          /** Some slice here was billed at this session's headline rate, not its own. */
          fallbackPriced: s.economics.fallbackPriced === true,
          cost: s.economics.cost,
          /** What it would have cost with no cache. The per-row saving. */
          uncachedCost: s.economics.uncachedCost,
          /**
           * API calls, not transcript lines. Already measured by the scanner,
           * and until now thrown away before it reached the page — it is the
           * denominator for "what did one request cost", which is the number
           * that makes a session comparable to another of a different length.
           */
          requests: s.requests ?? 0,
          /** All four kinds added together, as `tokens` means in every other row. */
          tokens:
            s.usage.inputTokens +
            s.usage.outputTokens +
            s.usage.cacheReadTokens +
            s.usage.cacheWriteTokens,
          input: s.usage.inputTokens,
          output: s.usage.outputTokens,
          cacheRead: s.usage.cacheReadTokens,
          cacheWrite: s.usage.cacheWriteTokens,
          /** Not a token count — searches, billed per search. See `COMPONENTS`. */
          searches: s.usage.webSearchRequests ?? 0,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          cacheHitRate: s.economics.cacheHitRate,
          contextRatio: s.economics.context?.ratio ?? null,
        })),
    ),
    firstAt: Math.min(...sessions.map((s) => s.startedAt).filter(Boolean), Date.now()),
    lastAt: Math.max(...sessions.map((s) => s.endedAt).filter(Boolean), 0),
  };
}
