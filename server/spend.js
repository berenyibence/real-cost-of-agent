/**
 * Where the money went.
 *
 * Total cost is the top of a tree, not the answer. Each level below it splits
 * the same dollars a different way — by what the tokens were (input, output,
 * cache read, cache write), by model, by project, by day, by session — so a
 * number can always be opened until it stops being a mystery.
 *
 * Every figure is derived from recorded token counts at published rates. The
 * multipliers are the ones the API actually bills: cache reads at 0.1x input,
 * 5-minute cache writes at 1.25x, 1-hour writes at 2x.
 */

import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  lookupModel,
} from './models.js';
import { dayKey } from './day.js';

const COMPONENTS = [
  {
    id: 'output',
    label: 'Output',
    hint: 'Tokens the model generated. The most expensive kind by a wide margin.',
    tokens: (u) => u.outputTokens,
    rate: (s) => s.outputRate,
    multiplier: 1,
  },
  {
    id: 'input',
    label: 'Fresh input',
    hint: 'Prompt tokens read at full price — never cached, or the cache had expired.',
    tokens: (u) => u.inputTokens,
    rate: (s) => s.inputRate,
    multiplier: 1,
  },
  {
    id: 'cacheWrite1h',
    label: 'Cache write (1h)',
    hint: 'Building the 1-hour cache. Billed at double the input rate, and worth it after ~3 reads.',
    tokens: (u) => u.cacheWrite1h,
    rate: (s) => s.inputRate,
    multiplier: CACHE_WRITE_1H_MULTIPLIER,
  },
  {
    id: 'cacheWrite5m',
    label: 'Cache write (5m)',
    hint: 'Building the 5-minute cache. Billed at 1.25x input, and worth it after 2 reads.',
    tokens: (u) => u.cacheWrite5m,
    rate: (s) => s.inputRate,
    multiplier: CACHE_WRITE_5M_MULTIPLIER,
  },
  {
    id: 'cacheRead',
    label: 'Cache read',
    hint: 'Re-reading a cached prefix at a tenth of the input rate. This is where caching pays.',
    tokens: (u) => u.cacheReadTokens,
    rate: (s) => s.inputRate,
    multiplier: CACHE_READ_MULTIPLIER,
  },
];

const emptyBucket = () => ({ cost: 0, tokens: 0, sessions: 0 });

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

  // Each slice carries its own usage and its own model. A session that reports
  // no split is one slice: the arithmetic below is then identical to the old
  // per-session version, which is why the fix changes nothing for those.
  const slices =
    Array.isArray(session.usageByModel) && session.usageByModel.length
      ? session.usageByModel.map((slice) => ({
          usage: slice,
          spec: lookupModel(slice.model) ?? spec,
        }))
      : [{ usage: session.usage, spec }];

  return COMPONENTS.map((c) => {
    let tokens = 0;
    let cost = 0;
    for (const { usage, spec: sliceSpec } of slices) {
      const n = c.tokens(usage) ?? 0;
      tokens += n;
      cost += (n * c.rate(sliceSpec) * c.multiplier) / 1_000_000;
    }
    return {
      id: c.id,
      label: c.label,
      hint: c.hint,
      tokens,
      multiplier: c.multiplier,
      // The headline rate stays the primary model's: it is a label for the
      // component, and a blended figure would be a number nobody is charged.
      effectiveRate: c.rate(spec) * c.multiplier,
      cost,
    };
  });
}

function addInto(map, key, seed, cost, tokens) {
  const cur = map.get(key) ?? { ...seed, ...emptyBucket() };
  cur.cost += cost;
  cur.tokens += tokens;
  cur.sessions += 1;
  map.set(key, cur);
}

/**
 * The full breakdown across a set of sessions.
 * `workspaces` supplies display names for project grouping.
 */
export function spendBreakdown(sessions, workspaces = []) {
  const wsName = new Map(workspaces.map((w) => [w.id, w.name]));

  const components = new Map(
    COMPONENTS.map((c) => [c.id, { id: c.id, label: c.label, hint: c.hint, tokens: 0, cost: 0 }]),
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
    const cost = session.economics.cost ?? 0;
    total += cost;
    uncached += session.economics.uncachedCost ?? 0;

    for (const part of componentsOf(session)) {
      const bucket = components.get(part.id);
      bucket.tokens += part.tokens;
      bucket.cost += part.cost;
      // Keep the last seen effective rate for display; it is per-model, so this
      // is indicative rather than exact when several models are mixed.
      bucket.effectiveRate = part.effectiveRate;
      bucket.multiplier = part.multiplier;
    }

    const tokens =
      session.usage.inputTokens +
      session.usage.outputTokens +
      session.usage.cacheReadTokens +
      session.usage.cacheWriteTokens;

    addInto(
      byModel,
      session.modelSpec.id,
      { id: session.modelSpec.id, name: session.modelSpec.name, tier: session.modelSpec.tier },
      cost,
      tokens,
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
      tokens,
    );
    // The user's calendar day, not UTC's — otherwise an evening session east of
    // Greenwich is filed under tomorrow.
    const day = dayKey(session.endedAt || Date.now());
    addInto(byDay, day, { id: day, date: day }, cost, tokens);
  }

  const sortByCost = (a, b) => b.cost - a.cost;
  const withShare = (rows) => rows.map((r) => ({ ...r, share: total > 0 ? r.cost / total : 0 }));

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
    components: withShare([...components.values()].sort(sortByCost)),
    byModel: withShare([...byModel.values()].sort(sortByCost)),
    byProject: withShare([...byProject.values()].sort(sortByCost)),
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    topSessions: withShare(
      sessions
        .filter((s) => s.economics)
        .sort((a, b) => b.economics.cost - a.economics.cost)
        .slice(0, 12)
        .map((s) => ({
          id: s.id,
          name: s.title,
          cost: s.economics.cost,
          tokens: s.usage.outputTokens,
          model: s.modelSpec?.name,
          project: wsName.get(s.workspaceId) ?? s.workspaceId,
          cacheHitRate: s.economics.cacheHitRate,
          contextRatio: s.economics.context?.ratio ?? null,
        })),
    ),
    firstAt: Math.min(...sessions.map((s) => s.startedAt).filter(Boolean), Date.now()),
    lastAt: Math.max(...sessions.map((s) => s.endedAt).filter(Boolean), 0),
  };
}
