/**
 * Real Cost of Agent — the page.
 *
 * The headline number is the top of a tree. Each cut re-splits the same dollars
 * a different way, and the subscription panel answers the question the token
 * figure alone cannot: did you actually pay this?
 *
 * No framework, no build step. The page is one screen with one shape of data,
 * and everything below is plain DOM.
 */

import {
  ANGLES,
  FORMATS,
  MARK_PATHS,
  cardBlob,
  paintShareCard,
  shareFacts,
  shareTargets,
  shareText,
  shareable,
} from './share.js';

/* ---------------------------------------------------------------- *
 * Formatting
 * ---------------------------------------------------------------- */

/** Money, at a precision that suits the magnitude. */
function money(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return `$${n.toFixed(2)}`;
  if (n < 10_000) return `$${n.toFixed(0)}`;
  return `$${(n / 1000).toFixed(1)}k`;
}

function compact(n) {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

function percent(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function shortPath(p) {
  if (!p) return '—';
  return p.replace(/^\/(Users|home)\/[^/]+/, '~');
}

function ago(ms) {
  if (!ms) return 'never';
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/* ---------------------------------------------------------------- *
 * DOM
 * ---------------------------------------------------------------- */

/**
 * `h('div.card', { onclick }, child, 'text')`.
 *
 * The tag accepts `tag.class.class` because nearly every node here is a div
 * carrying one or two classes, and writing that out longhand buried the
 * structure under punctuation.
 */
function h(spec, props = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = `${el.className} ${value}`.trim();
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'html') el.innerHTML = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** The 16px stroke set, hidden from screen readers — every one sits by a label. */
const ICON_PATHS = {
  coin: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5A2.5 2.5 0 0 0 12 8c-1.4 0-2.5.7-2.5 2s1.1 2 2.5 2 2.5.6 2.5 2-1.1 2-2.5 2a2.5 2.5 0 0 1-2.5-1.5M12 6.5v11"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z"/><path d="M12 17v5"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11.5v4.5"/><path d="M12 8h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16.5h.01"/>',
  refresh:
    '<path d="M20 11a8 8 0 0 0-13.7-5.4L3 9"/><path d="M4 13a8 8 0 0 0 13.7 5.4L21 15"/><path d="M3 4v5h5M21 20v-5h-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  share: '<path d="M4 13v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"/><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/>',
  download:
    '<path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/><path d="M12 3v12"/><path d="M8 11l4 4 4-4"/>',
  copy: '<path d="M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  // The brand mark, so the header, the canvas and the favicon are one drawing.
  mark: MARK_PATHS.map((d) => `<path d="${d}"/>`).join(''),
};

function icon(name, size = 16) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.8');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = ICON_PATHS[name] ?? '';
  return el;
}

function card(title, hint, action, ...body) {
  const head = title
    ? h('header.card-head', {}, h('h2', {}, title), hint && h('span.hint', {}, hint), action)
    : null;
  return h('section.card', {}, head, ...body);
}

/* ---------------------------------------------------------------- *
 * State
 * ---------------------------------------------------------------- */

const CUTS = [
  {
    id: 'components',
    label: 'What the tokens were',
    hint: 'Output, input, and the two kinds of cache traffic.',
  },
  { id: 'byModel', label: 'By model', hint: 'Which models the money went to.' },
  { id: 'byProject', label: 'By project', hint: 'Which codebases cost the most.' },
  { id: 'byDay', label: 'By day', hint: 'When the spend happened.' },
  { id: 'topSessions', label: 'By session', hint: 'The individual runs that dominate.' },
];

const state = {
  spend: null,
  billing: null,
  cut: 'components',
  saving: false,
  saved: false,
  error: null,
  share: {
    format: 'landscape',
    angle: 'value',
    tone: 'short',
    /** `null` means "whatever the generator produced"; a string means the user edited it. */
    text: null,
    status: null,
  },
};

const root = document.getElementById('root');

async function json(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function load() {
  try {
    const [spend, billing] = await Promise.all([json('/api/spend'), json('/api/billing')]);
    state.spend = spend;
    state.billing = billing;
    state.error = null;
  } catch (err) {
    state.error = err.message;
  }
  render();
}

/** Save a preference, then re-read the figures it changes. */
async function saveBilling(patch) {
  state.saving = true;
  render();
  try {
    const { config } = await json('/api/billing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    state.billing = { ...state.billing, config };
    // The comparison is recomputed from the stored config on every request, so
    // the new plan is visible immediately rather than after a re-index.
    state.spend = await json('/api/spend');
    state.saved = true;
  } catch (err) {
    state.error = err.message;
  } finally {
    state.saving = false;
    render();
  }
}

/* ---------------------------------------------------------------- *
 * Two prices, compared
 *
 * Not two invoices — see `compareBilling`. Nothing in `~/.claude` records what
 * anybody was charged, so this panel shows what the tokens would cost at list
 * rates, what the plan costs over the same span, and which way the gap runs.
 *
 * It used to lead with a green tick and "API credits spent: $0". That figure
 * was not measured, and could not be: it was inferred from which betas appear
 * in local telemetry. The inference is probably right, but a dollar amount
 * asserted in a confirmation box is a claim of a different order from "this is
 * how you authenticate", and only the second one is on disk.
 * ---------------------------------------------------------------- */

/**
 * What to tell someone once the two prices are known.
 *
 * The unflattering verdict is the one that earns the rest their credibility. A
 * tool that can only ever conclude "your subscription is great" is an
 * advertisement, so when the volume does not justify the plan this says so, in
 * the same voice and the same size.
 */
const VERDICTS = {
  'plan-ahead': {
    tone: 'good',
    icon: 'check',
    render: (b) =>
      `<strong>The plan is ahead by ${money(b.difference)}.</strong> These tokens would cost ` +
      `${money(b.apiEquivalent)} at published API rates, against ${money(b.planCost)} for ` +
      `${b.planLabel} over ${plural(b.declaredMonths, 'month')} — so every $1 of plan bought ` +
      `<strong>$${b.ratio.toFixed(2)}</strong> of usage at list prices.`,
  },
  close: {
    tone: 'neutral',
    icon: 'info',
    render: (b) =>
      `<strong>It is close to a wash.</strong> ${money(b.apiEquivalent)} of usage at list rates ` +
      `against ${money(b.planCost)} of plan over ${plural(b.declaredMonths, 'month')} — within ` +
      `${percent(Math.abs(1 - b.ratio))} of each other. At this level of use the price is not the ` +
      `deciding factor; rate limits and a bill that does not move are.`,
  },
  'api-ahead': {
    tone: 'warn',
    icon: 'alert',
    render: (b) =>
      `<strong>Metered API billing looks cheaper for you.</strong> These tokens come to ` +
      `${money(b.apiEquivalent)} at list rates, while ${b.planLabel} costs ${money(b.planCost)} ` +
      `over ${plural(b.declaredMonths, 'month')} — <strong>${money(-b.difference)}</strong> more than the ` +
      `usage. If your use stays at this level, an API key would bill you less. A plan also buys ` +
      `higher rate limits and a bill that does not move, so this is an argument about volume rather ` +
      `than the whole argument.`,
  },
  'no-plan': {
    tone: 'neutral',
    icon: 'info',
    render: (b) =>
      `<strong>Set a plan to make this a comparison.</strong> These tokens would cost ` +
      `${money(b.apiEquivalent)} at published API rates. Choose what you actually pay below and ` +
      `this becomes a number you can act on.`,
  },
  'no-usage': {
    tone: 'neutral',
    icon: 'info',
    render: () =>
      `<strong>Nothing priced yet.</strong> No session on this machine carries usage that could be ` +
      `priced, so there is nothing to compare a plan against.`,
  },
};

function billingPanel() {
  const b = state.spend.billing;
  const config = state.billing?.config;
  const plans = state.billing?.plans ?? [];

  const cell = (iconName, label, value, sub, color) =>
    h(
      'div.billing-cell',
      {},
      h('div.stat-label', {}, icon(iconName, 13), label),
      h('div.stat-value', { style: color ? { color } : {} }, value),
      h('div.stat-sub', {}, sub),
    );

  const grid = h(
    'div.billing-grid',
    {},
    cell(
      'coin',
      'At API list rates',
      money(b.apiEquivalent),
      b.metered ? 'metered, so this is your bill' : 'what these tokens would cost, metered',
    ),
    cell(
      'plug',
      'Your plan, this period',
      b.planCost > 0 ? money(b.planCost) : '—',
      b.planCost > 0
        ? `${b.planLabel} · ${plural(b.declaredMonths, 'month')}`
        : 'no plan set — choose one below',
    ),
    cell(
      'zap',
      'Ratio',
      b.ratio ? `${b.ratio.toFixed(1)}×` : '—',
      b.ratio
        ? `every $1 of plan bought $${b.ratio.toFixed(2)} at list rates`
        : 'set a plan to compare',
      b.verdict === 'api-ahead' ? 'var(--warn)' : 'var(--accent-text)',
    ),
  );

  const spec = VERDICTS[b.verdict] ?? VERDICTS['no-plan'];
  const verdict = h(
    `div.verdict.${spec.tone}`,
    {},
    icon(spec.icon, 13),
    h('div', { html: spec.render(b) }),
  );

  // What the two figures are, said once, next to them rather than in a footnote
  // nobody reaches. Both halves matter: neither number came off an invoice.
  const authSentence =
    b.authMode === 'subscription'
      ? 'Claude Code authenticates over OAuth here, so this usage drew on plan limits rather than metered API billing.'
      : b.authMode === 'api'
        ? 'Claude Code authenticates with an API key here, so the list-rate figure is what you were actually metered.'
        : 'How Claude Code authenticates could not be determined from local telemetry, so which side of this is hypothetical is unclear.';

  const note = h(
    'div.billing-note',
    {},
    h('div', {
      html:
        '<strong>This compares two prices, not two invoices.</strong> Nothing in ' +
        '<code>~/.claude</code> records what you were charged — the transcripts carry token counts, ' +
        'not dollars. The figure on the left is computed from published rates; the one beside it is ' +
        `the price you set below. ${authSentence}` +
        // Two different ways the two sides can cover different stretches of
        // time. Both are ordinary; neither should have to be worked out from
        // the numbers by a reader who was not looking for it.
        (b.spanMismatch
          ? ` The plan below covers <strong>${plural(b.declaredMonths, 'month')}</strong> while the ` +
            `transcripts here span <strong>${plural(b.months, 'month')}</strong>, so the two sides ` +
            'are measuring different stretches of time.'
          : b.partialPeriod
            ? ` These transcripts span <strong>${plural(b.days, 'day')}</strong>, less than the month ` +
              'the plan is charged for — so the plan side of this covers more time than the usage side.'
            : ''),
    }),
  );

  /* ---- the plan editor: one row per period ---- */

  const periods = config?.periods ?? [];
  const savePeriods = (next) => saveBilling({ periods: next });
  const patchPeriod = (index, patch) =>
    savePeriods(periods.map((p, i) => (i === index ? { ...p, ...patch } : p)));

  /**
   * A committed number, not a live one.
   *
   * `render()` rebuilds the panel from the response, so saving per keystroke
   * would take the caret out of the box being typed in — and "2" on the way to
   * "24" is a real value that would be stored and priced on the way past.
   */
  const number = (label, value, placeholder, min, commit) =>
    h(
      'label.search',
      {},
      h('span.faint', { style: { fontSize: '11px' } }, label),
      h('input', {
        type: 'number',
        min,
        placeholder,
        value: value ?? '',
        onblur: (e) => commit(e.target.value === '' ? null : Number(e.target.value)),
        onkeydown: (e) => {
          if (e.key === 'Enter') e.target.blur();
        },
      }),
    );

  const rows = periods.map((period, index) => {
    const listPrice = plans.find((p) => p.id === period.planId)?.monthly ?? 0;
    const only = periods.length < 2;
    return h(
      'div.period-row',
      {},
      h(
        'select.select',
        { onchange: (e) => patchPeriod(index, { planId: e.target.value, monthlyOverride: null }) },
        ...plans.map((p) =>
          h(
            'option',
            { value: p.id, selected: period.planId === p.id },
            `${p.name}${p.monthly ? ` — $${p.monthly}/mo` : ''}`,
          ),
        ),
      ),
      number('$/mo', period.monthlyOverride, String(listPrice), '0', (v) =>
        patchPeriod(index, { monthlyOverride: v }),
      ),
      number('seats', period.seats ?? 1, '1', '1', (v) =>
        patchPeriod(index, { seats: Math.max(1, v ?? 1) }),
      ),
      // Empty means "however long the transcripts run", which is the answer for
      // anyone who has not changed tier. The placeholder says what that is, so
      // an empty box is never a mystery.
      number('months', period.months, `${b.months} detected`, '1', (v) =>
        patchPeriod(index, { months: v }),
      ),
      h(
        'button.period-remove',
        {
          disabled: only,
          'aria-label': 'Remove this period',
          title: only ? 'At least one period is needed' : 'Remove this period',
          onclick: () => savePeriods(periods.filter((_, i) => i !== index)),
        },
        icon('close', 14),
      ),
    );
  });

  const priced = b.periods ?? [];
  const config_ = h(
    'div.billing-config',
    {},
    h(
      'span.faint',
      { style: { fontSize: '11.5px' } },
      'Plan tier is not recorded anywhere on disk, so set it here. Prices are editable — published ' +
        'pricing changes and this app will not show a stale figure as fact. Add a period for each ' +
        'tier you have been on, and set its length when the transcripts here do not cover it.',
    ),
    h('div.periods', {}, ...rows),
    h(
      'div.periods-foot',
      {},
      h(
        'button.action',
        {
          onclick: () =>
            savePeriods([
              ...periods,
              // Same tier, one month: a starting point to edit rather than a
              // guess about which plan somebody moved to.
              { ...(periods[periods.length - 1] ?? {}), months: 1 },
            ]),
        },
        icon('plus', 14),
        'Add a period',
      ),
      priced.length > 1 &&
        h(
          'span.periods-total',
          {},
          `${plural(priced.length, 'period')} · ${money(b.planCost)} over ${plural(b.declaredMonths, 'month')}`,
        ),
      state.saving && h('span.faint', { style: { fontSize: '11px' } }, 'saving…'),
      !state.saving && state.saved && h('span.faint', { style: { fontSize: '11px' } }, 'saved'),
    ),
    b.authEvidence &&
      h(
        'div.faint.mono',
        { style: { fontSize: '10.5px', marginTop: '10px' } },
        `detection: ${b.authEvidence}`,
      ),
  );

  const hint =
    b.authMode === 'subscription'
      ? 'Authenticating over OAuth'
      : b.authMode === 'api'
        ? 'Authenticating with an API key'
        : 'Auth mode undetermined';

  return card('Plan versus list rates', hint, null, grid, verdict, note, config_);
}

/* ---------------------------------------------------------------- *
 * What this total leaves out, and what it had to assume.
 *
 * The model catalog is maintained by hand and models ship without asking it. A
 * rate is inferred from the tier where the id says one, which is right far more
 * often than zero is. But "probably right" is a different claim from "this is
 * what you were charged", and a money view that will not distinguish them has no
 * business showing either.
 * ---------------------------------------------------------------- */

function caveats() {
  const { unpriced, inferredSessions } = state.spend;
  if (!unpriced?.sessions && !inferredSessions) return null;

  const box = h('div.card.caveats');

  if (inferredSessions > 0) {
    box.append(
      h('p', {
        html:
          `<strong>${inferredSessions}</strong> ${inferredSessions === 1 ? 'session was' : 'sessions were'} ` +
          "priced at their tier's published rate — the exact model id is not in this app's catalog, " +
          'so the figure is an estimate rather than a rate card.',
      }),
    );
  }

  if (unpriced?.sessions > 0) {
    const models = unpriced.models.length ? unpriced.models.join(', ') : 'the model recorded';
    // Whether that matters is the question a bare count leaves open, and the
    // answer belongs right here: an excluded session carrying no tokens cost
    // nothing, and saying so is the difference between a caveat and an alarm.
    const impact =
      unpriced.tokens > 0
        ? `That is <strong>${unpriced.tokens.toLocaleString()}</strong> tokens of work the figure above does not account for.`
        : `${unpriced.sessions === 1 ? 'It recorded' : 'They recorded'} no token usage, so the figure above is unaffected.`;
    box.append(
      h('p', {
        html:
          `<strong>${unpriced.sessions}</strong> ${unpriced.sessions === 1 ? 'session is' : 'sessions are'} ` +
          `not in this total: no rate is known for ${models}. ${impact}`,
      }),
    );
  }

  return box;
}

/* ---------------------------------------------------------------- *
 * The cuts
 * ---------------------------------------------------------------- */

function barRow({ name, pill, meta, sub, width, value, share }) {
  return h(
    'div.bar-row',
    {},
    h(
      'div',
      {},
      h(
        'div.label',
        {},
        h('span.name', {}, name),
        pill && h('span.pill', {}, pill),
        meta && h('span.faint', { style: { fontSize: '11px' } }, meta),
      ),
      h('div.bar-track', {}, h('div.bar-fill', { style: { width: `${width * 100}%` } })),
      sub && h('div.sub', {}, sub),
    ),
    h(
      'div.amount',
      {},
      h('div.value', {}, value),
      share != null && h('div.share', {}, share),
    ),
  );
}

function components(rows) {
  const max = Math.max(1, ...rows.map((r) => r.cost));
  return h(
    'div.rows',
    {},
    ...rows.map((r) =>
      barRow({
        name: r.label,
        pill: r.multiplier != null && r.multiplier !== 1 ? `×${r.multiplier}` : null,
        meta: `${compact(r.tokens)} tokens`,
        sub: r.hint,
        width: r.cost / max,
        value: money(r.cost),
        share: percent(r.share),
      }),
    ),
  );
}

function buckets(rows, total) {
  const max = Math.max(1, ...rows.map((r) => r.cost));
  return h(
    'div.rows',
    {},
    ...rows.map((r) =>
      barRow({
        name: r.name ?? r.id,
        meta: plural(r.sessions, 'session'),
        sub: r.path ? h('span.mono.faint', {}, shortPath(r.path)) : null,
        width: r.cost / max,
        value: money(r.cost),
        share: percent(total > 0 ? r.cost / total : 0),
      }),
    ),
  );
}

/**
 * The rows that dominate the bill.
 *
 * Deliberately not links: this page is the whole application, and a row that
 * looks clickable but opens nothing is worse than a row that never claimed to.
 */
function topSessions(rows) {
  const max = Math.max(1, ...rows.map((r) => r.cost));
  return h(
    'div.rows',
    {},
    ...rows.map((s) =>
      barRow({
        name: s.name,
        pill: s.model,
        width: s.cost / max,
        sub:
          `${s.project} · cache ${percent(s.cacheHitRate, 1)}` +
          (s.contextRatio != null ? ` · context peak ${percent(s.contextRatio)}` : ''),
        value: money(s.cost),
        share: percent(s.share),
      }),
    ),
  );
}

function byDay(rows) {
  const max = Math.max(1, ...rows.map((r) => r.cost));
  const recent = rows.slice(-30);
  const chart = h(
    'div.activity',
    {},
    ...recent.map((d) =>
      h(
        'div.activity-col',
        { title: `${d.date} · ${money(d.cost)} · ${plural(d.sessions, 'session')}` },
        h('div.activity-bar', {
          style: { height: `${Math.max(2, (d.cost / max) * 100)}%` },
        }),
      ),
    ),
  );
  const axis = h(
    'div.activity-axis',
    {},
    h('span', {}, recent[0]?.date ?? ''),
    h('span', {}, `peak ${money(max)}/day`),
    h('span', {}, recent[recent.length - 1]?.date ?? ''),
  );
  return h('div', {}, chart, axis);
}

function whereItWent() {
  const data = state.spend;
  const cut = CUTS.find((c) => c.id === state.cut);

  const segmented = h(
    'div.segmented',
    {},
    ...CUTS.map((c) =>
      h(
        'button',
        {
          class: c.id === state.cut ? 'active' : null,
          onclick: () => {
            state.cut = c.id;
            render();
          },
        },
        c.label,
      ),
    ),
  );

  let body;
  if (state.cut === 'components') body = components(data.components);
  else if (state.cut === 'byDay') body = byDay(data.byDay);
  else if (state.cut === 'topSessions') body = topSessions(data.topSessions);
  else body = buckets(data[state.cut], data.total);

  if (!body.childElementCount) {
    body = h('div.empty', {}, h('strong', {}, 'Nothing to split here yet'));
  }

  return card('Where the money went', cut?.hint, segmented, body);
}

/* ---------------------------------------------------------------- *
 * Sharing
 *
 * A local page has no audience, and this project only exists because somebody's
 * number surprised them enough to want to say it out loud.
 *
 * Two properties are load-bearing here. **Nothing is posted by anything on this
 * panel** — each platform link opens that platform's own composer with the text
 * already in it, and a person still has to press post. And **the box is the
 * post**: every button sends exactly the characters visible in the textarea, so
 * there is no second, unedited version of your words going somewhere you cannot
 * see. What may appear in that box at all is fixed by `shareFacts` in
 * `share.js`, which is an allowlist of aggregates — a project name, a path or a
 * session title cannot reach it.
 * ---------------------------------------------------------------- */

/**
 * One canvas for the life of the page.
 *
 * `render()` replaces `#root` wholesale, and a canvas rebuilt on every
 * keystroke would repaint a 2400px bitmap to show the same picture.
 */
const shareCanvas = h('canvas.share-canvas', {
  role: 'img',
  'aria-label': 'Preview of the image that will be shared',
});
const shareStatus = h('span.share-status');
const shareCount = h('span.share-count.faint');
let shareBox = null;
let shareTargetEls = [];

function generatedShareText(facts) {
  return state.share.text ?? shareText(facts, { tone: state.share.tone, angle: state.share.angle });
}

function setShareStatus(message, tone = 'ok') {
  shareStatus.textContent = message ?? '';
  shareStatus.className = `share-status ${message ? tone : ''}`.trim();
}

/**
 * Re-point the platform links at whatever the box currently says.
 *
 * Deliberately not a `render()`: rebuilding the panel on every keystroke would
 * take the caret out of the textarea the user is typing in.
 */
function syncShare() {
  if (!shareBox) return;
  const text = shareBox.value;
  const targets = shareTargets(shareFacts(state.spend), {
    short: text,
    long: text,
    angle: state.share.angle,
  });
  const byId = new Map(targets.map((t) => [t.id, t]));
  for (const { id, el } of shareTargetEls) {
    const href = byId.get(id)?.href;
    if (href) el.href = href;
  }
  // A long post is *meant* to be over 280 — LinkedIn, Reddit and an Instagram
  // caption all want the long one. So the count states the consequence rather
  // than scolding, and only turns amber when the length contradicts what the
  // user asked for: a short post that will not fit where short posts go.
  const n = text.length;
  shareCount.textContent =
    n <= 280
      ? `${n} characters — fits everywhere`
      : n <= 300
        ? `${n} characters — over X's limit of 280, fine elsewhere`
        : `${n} characters — right for LinkedIn, Reddit and Instagram; over the limit on X (280) and Bluesky (300)`;
  shareCount.classList.toggle('over', n > 280 && state.share.tone === 'short');
}

/**
 * Copy, with the pre-clipboard-API fallback still in place.
 *
 * `navigator.clipboard` needs a secure context. `127.0.0.1` is one, so the
 * documented way of running this is fine — but somebody who has bound the
 * server to a LAN address to read their numbers from a laptop is on plain
 * http, and losing copy entirely there is a worse outcome than a deprecated
 * call.
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const box = shareBox;
    if (!box) throw new Error('clipboard unavailable — select the text and copy it');
    box.select();
    if (!document.execCommand?.('copy')) {
      throw new Error('clipboard unavailable — the text is selected, press copy');
    }
    box.setSelectionRange(box.value.length, box.value.length);
  }
}

async function copyImage() {
  const blob = await cardBlob(shareCanvas);
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('this browser cannot copy images — use Download instead');
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

async function downloadImage() {
  const blob = await cardBlob(shareCanvas);
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: `real-cost-of-agent-${state.share.format}.png` });
  link.click();
  // Safari still wants the object alive while it handles the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Run an action and report the outcome in one place, rather than failing silently. */
function action(label, iconName, message, fn) {
  return h(
    'button.action',
    {
      onclick: async () => {
        try {
          await fn();
          setShareStatus(message);
        } catch (err) {
          setShareStatus(err.message, 'bad');
        }
      },
    },
    icon(iconName, 14),
    label,
  );
}

function sharePanel() {
  if (!shareable(state.spend)) return null;

  const facts = shareFacts(state.spend);
  const spec = paintShareCard(shareCanvas, facts, {
    format: state.share.format,
    angle: state.share.angle,
  });
  shareCanvas.style.aspectRatio = `${spec.w} / ${spec.h}`;

  // The angle drives the words *and* the headline on the card, so they cannot
  // drift apart — a caption that contradicts the picture above it is the one
  // mistake this panel exists to make impossible.
  const angles = h(
    'div.segmented',
    {},
    ...ANGLES.map((a) =>
      h(
        'button',
        {
          class: a.id === state.share.angle ? 'active' : null,
          title: a.note,
          onclick: () => {
            state.share.angle = a.id;
            state.share.text = null;
            render();
          },
        },
        a.label,
      ),
    ),
  );

  const formats = h(
    'div.segmented',
    {},
    ...FORMATS.map((f) =>
      h(
        'button',
        {
          class: f.id === state.share.format ? 'active' : null,
          title: f.note,
          onclick: () => {
            state.share.format = f.id;
            render();
          },
        },
        f.label,
      ),
    ),
  );

  const tones = h(
    'div.segmented',
    {},
    ...[
      { id: 'short', label: 'Short', note: 'Fits X and Bluesky.' },
      { id: 'long', label: 'Long', note: 'For LinkedIn, Reddit and Instagram captions.' },
    ].map((t) =>
      h(
        'button',
        {
          class: t.id === state.share.tone ? 'active' : null,
          title: t.note,
          onclick: () => {
            state.share.tone = t.id;
            // A tone is a starting point, not a filter over the user's words:
            // switching it rewrites the box, so an edit is never half-applied.
            state.share.text = null;
            render();
          },
        },
        t.label,
      ),
    ),
  );

  shareBox = h('textarea.share-box', {
    rows: state.share.tone === 'long' ? 12 : 7,
    spellcheck: 'false',
    'aria-label': 'The post. Edit it — every button below sends exactly this.',
    oninput: (e) => {
      state.share.text = e.target.value;
      syncShare();
      setShareStatus(null);
    },
  });
  shareBox.value = generatedShareText(facts);

  const targets = shareTargets(facts, {
    short: shareBox.value,
    long: shareBox.value,
    angle: state.share.angle,
  });
  shareTargetEls = [];

  const buttons = targets.map((target) => {
    const label = h(
      'span.share-target-label',
      {},
      target.label,
      target.href ? icon('external', 12) : icon('copy', 12),
    );

    // Facebook takes a URL and nothing else; Instagram has no web composer at
    // all. Both put the text on the clipboard on the way out, because the
    // alternative is sending someone to an empty box wondering where it went.
    const carryTheText = async () => {
      if (target.prefills) return;
      await copyText(shareBox.value);
      setShareStatus(
        target.id === 'instagram'
          ? 'Caption copied. Download the image, then paste this when you post it.'
          : 'Text copied — paste it into the composer that just opened.',
      );
    };

    const el = target.href
      ? h(
          'a.share-target',
          {
            href: target.href,
            target: '_blank',
            rel: 'noopener noreferrer',
            title: target.note ?? `Open the ${target.label} composer with this post in it`,
            onclick: carryTheText,
          },
          label,
        )
      : h(
          'button.share-target',
          {
            title: target.note,
            onclick: () =>
              carryTheText().catch((err) => setShareStatus(err.message, 'bad')),
          },
          label,
        );

    shareTargetEls.push({ id: target.id, el });
    return el;
  });

  const notes = targets.filter((t) => t.note);

  const panel = h(
    'div.share-body',
    {},
    h('div.share-preview', {}, shareCanvas, h('div.share-format-note', {}, spec.note)),
    h(
      'div.share-compose',
      {},
      h(
        'div.share-controls',
        {},
        h('div.share-control', {}, h('span.share-control-label', {}, 'Angle'), angles),
        h('div.share-control', {}, h('span.share-control-label', {}, 'Crop'), formats),
        h('div.share-control', {}, h('span.share-control-label', {}, 'Length'), tones),
      ),
      shareBox,
      h('div.share-meta', {}, shareCount),
      h(
        'div.share-actions',
        {},
        action('Copy text', 'copy', 'Post copied to the clipboard.', () => copyText(shareBox.value)),
        action('Copy image', 'copy', 'Image copied — paste it straight into a composer.', copyImage),
        action('Download image', 'download', `Saved as PNG at ${spec.w}×${spec.h}.`, downloadImage),
        shareStatus,
      ),
    ),
  );

  const platforms = h(
    'div.share-platforms',
    {},
    h('span.share-platforms-label', {}, 'Post to'),
    ...buttons,
  );

  const disclosure = h(
    'div.share-disclosure',
    {},
    h('p', {
      html:
        '<strong>Nothing is posted by this page.</strong> Each button opens that platform in a new ' +
        'tab with the text above already in the composer — the post is still yours to make, edit ' +
        'or abandon. These links are the only thing in this project that points off your machine.',
    }),
    h('p', {
      html:
        '<strong>What can travel:</strong> the total, your plan’s name, the month count, how many ' +
        'sessions and projects, and the percentage split. Project names, file paths and session ' +
        'titles are not in the data this panel is given — that is enforced in ' +
        '<code>web/share.js</code> and asserted in <code>test/share.test.js</code>.',
    }),
    notes.length &&
      h(
        'ul.share-notes',
        {},
        ...notes.map((t) => h('li', {}, h('strong', {}, `${t.label}: `), t.note)),
      ),
  );

  return card(
    'Share what this found',
    'The number is more interesting to other people than you think',
    null,
    panel,
    platforms,
    disclosure,
  );
}

/* ---------------------------------------------------------------- *
 * Render
 * ---------------------------------------------------------------- */

function render() {
  root.replaceChildren();

  if (state.error) {
    root.append(
      h(
        'div.card.empty',
        {},
        h('strong', {}, 'The server did not answer'),
        h('span', {}, state.error),
      ),
    );
    return;
  }

  if (!state.spend) {
    root.append(h('div.skeleton', { style: { height: '360px' } }));
    return;
  }

  const meta = state.spend.meta ?? {};
  const subtitle = document.getElementById('subtitle');
  subtitle.textContent = meta.found
    ? `${plural(meta.sessions, 'session')} across ${plural(meta.workspaces, 'project')} · indexed ${ago(meta.scannedAt)}`
    : 'What your agent would have cost';

  if (!meta.found) {
    root.append(
      h(
        'div.card.empty',
        {},
        h('strong', {}, 'No Claude Code transcripts on this machine'),
        h('span', {}, 'Nothing was found at'),
        h('code', {}, meta.claudeDir ?? '~/.claude/projects'),
        h(
          'span',
          {},
          'Run Claude Code once, or point this app elsewhere with CLAUDE_HOME, then re-read.',
        ),
      ),
    );
    return;
  }

  root.append(billingPanel());
  const notes = caveats();
  if (notes) root.append(notes);
  root.append(whereItWent());

  const share = sharePanel();
  if (share) {
    root.append(share);
    // The links are built from the box, and the box only exists once it is in
    // the document — so the first pointing happens here, not inside the panel.
    syncShare();
  }
  shareButton.hidden = !share;
}

/* ---------------------------------------------------------------- *
 * Chrome
 * ---------------------------------------------------------------- */

/**
 * The header's share button is a shortcut to the panel, not a second copy of
 * it. The panel sits at the bottom because this is a tool before it is a
 * megaphone — but a feature nobody scrolls to may as well not exist.
 */
const shareButton = document.getElementById('share');
shareButton.append(icon('share'));
shareButton.hidden = true;
shareButton.addEventListener('click', () => {
  shareBox?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  shareBox?.focus({ preventScroll: true });
});

const rescan = document.getElementById('rescan');
rescan.append(icon('refresh'));
rescan.addEventListener('click', async () => {
  rescan.classList.add('busy');
  try {
    await json('/api/refresh', { method: 'POST' });
    await load();
  } catch (err) {
    state.error = err.message;
    render();
  } finally {
    rescan.classList.remove('busy');
  }
});

const themeButton = document.getElementById('theme');
const paintThemeIcon = () => {
  themeButton.replaceChildren(
    icon(document.documentElement.dataset.theme === 'light' ? 'moon' : 'sun'),
  );
};
themeButton.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('real-cost-of-agent-theme', next);
  paintThemeIcon();
});
paintThemeIcon();

load();
