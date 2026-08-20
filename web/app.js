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

/**
 * Thousands separators, written out rather than left to the locale.
 *
 * `toLocaleString` would render 2288 as "2.288" in half of Europe, which beside
 * a `$` reads as two dollars and change. The share card has always grouped with
 * commas; this is the same spelling, so one number is not written two ways
 * depending on which half of the app is showing it.
 */
const group = (digits) => String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Money, at a precision that suits the magnitude. */
function money(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  // Split off the sign before comparing: an unsigned `n < 0.01` reported every
  // negative figure as "<$0.01", which is a rounding claim about a number that
  // is not small and is not positive.
  const sign = n < 0 ? '-' : '';
  const v = Math.abs(n);
  if (v < 0.01) return `${sign}<$0.01`;
  if (v < 100) return `${sign}$${v.toFixed(2)}`;
  if (v < 10_000) return `${sign}$${group(v.toFixed(0))}`;
  return `${sign}$${(v / 1000).toFixed(1)}k`;
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

/**
 * A project path with the home directory folded to `~`.
 *
 * The Windows spelling is here because CI runs on Windows and `~/.claude` is a
 * real place there — the paths inside a transcript are then `C:\Users\name\…`,
 * which the POSIX pattern leaves untouched, printing somebody's full name in
 * every row of the by-project cut.
 */
function shortPath(p) {
  if (!p) return '—';
  return String(p)
    .replace(/^\/(Users|home)\/[^/]+/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
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

/**
 * Escape a value that came off disk before it goes anywhere near `html:`.
 *
 * Everything else interpolated into markup here is either a literal written in
 * this file or a number formatted by it. Model ids are the one exception: they
 * are whatever string a transcript happened to record, and a session routed
 * through a proxy or a gateway can put anything in that field. It is your own
 * machine and your own files, so this is not much of an attack — but "not much
 * of an attack" is a thin reason to feed file contents to `innerHTML`, and the
 * fix is four lines.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

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
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
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

/**
 * A row of mutually exclusive buttons: the cuts, and the share panel's angle,
 * crop and length pickers.
 *
 * `aria-pressed` rather than the `active` class alone. Which one is selected is
 * obvious to look at and completely invisible otherwise, and this is the only
 * control on the page that carries state.
 */
function segmented(items, activeId, onPick) {
  return h(
    'div.segmented',
    { role: 'group' },
    ...items.map((item) =>
      h(
        'button',
        {
          class: item.id === activeId ? 'active' : null,
          'aria-pressed': item.id === activeId ? 'true' : 'false',
          // The cuts carry `hint`; the share pickers carry `note`. Both are the
          // one-line explanation, and only the selected cut's is on screen.
          title: item.note ?? item.hint,
          onclick: () => onPick(item.id),
        },
        item.label,
      ),
    ),
  );
}

function card(title, hint, action, ...body) {
  const head = title
    ? h(
        'header.card-head',
        {},
        h('h2', {}, title),
        // `title` because the hint ellipsizes rather than wrapping — see the
        // rule in styles.css for why it must not push the controls onto a
        // second line.
        hint && h('span.hint', { title: hint }, hint),
        action,
      )
    : null;
  return h('section.card', {}, head, ...body);
}

/* ---------------------------------------------------------------- *
 * State
 * ---------------------------------------------------------------- */

const CUTS = [
  {
    id: 'components',
    label: 'What was billed',
    // It was "What the tokens were", which stopped being true when web search
    // arrived: that row is searches, not tokens, and the heading over a column
    // has to describe the column.
    hint: 'Output, input, the two kinds of cache traffic — and the searches, which are not tokens.',
  },
  { id: 'byModel', label: 'By model', hint: 'Which models the money went to.' },
  { id: 'byProject', label: 'By project', hint: 'Which codebases cost the most.' },
  {
    id: 'bySource',
    label: 'By agent',
    hint: 'Which machine or container ran it.',
    /**
     * Hidden until there is a fleet, because a split of one is not a split.
     * Every headless container works in the same directory, so the by-project
     * cut collapses them into one row and this is the only cut that can tell
     * them apart — but on a laptop it would be that same one row again under a
     * second heading.
     */
    when: (data) => (data.bySource?.length ?? 0) > 1,
  },
  { id: 'byDay', label: 'By day', hint: 'When the spend happened.' },
  {
    id: 'bySession',
    label: 'By session',
    hint: 'Every run, with the token counts behind each figure.',
  },
];

const state = {
  spend: null,
  billing: null,
  cut: 'components',
  error: null,
  /** The session browser's controls. The filter text lives on the input itself. */
  sessions: { sort: 'cost', limit: 25 },
  share: {
    format: 'landscape',
    // Matches `ANGLES[0]` in share.js, which is where the reasoning lives.
    angle: 'saved',
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

/**
 * `fresh` re-reads the telemetry behind auth detection as well as the figures.
 *
 * That detection is cached for the life of the process — it reads a few hundred
 * KB and the answer rarely changes — and `/api/billing?refresh=1` has always
 * existed to bust it. Nothing ever called it, so a user who switched between an
 * API key and a subscription kept being told the old answer until they
 * restarted the server. The button in the header says "Re-read transcripts",
 * and re-reading is what it now does; an ordinary page load still uses the
 * cache.
 */
async function load({ fresh = false } = {}) {
  try {
    const [spend, billing] = await Promise.all([
      json('/api/spend'),
      json(`/api/billing${fresh ? '?refresh=1' : ''}`),
    ]);
    state.spend = spend;
    state.billing = billing;
    state.error = null;
  } catch (err) {
    state.error = err.message;
  }
  render();
}

/**
 * The plan editor's status line, which survives `render()`.
 *
 * Kept outside the tree the way `shareStatus` is, for two reasons. A
 * confirmation has to be able to time out, and doing that through `render()`
 * would rebuild the panel two seconds later — taking the caret out of whichever
 * box the user had moved on to. And "saved" is a confirmation rather than a
 * state: left in the markup it stayed on screen for the rest of the session,
 * long after it had stopped meaning anything.
 */
const planStatus = h('span.faint', {
  style: { fontSize: '11px' },
  'aria-live': 'polite',
});
let planStatusTimer = null;

function setPlanStatus(message, { transient = false } = {}) {
  clearTimeout(planStatusTimer);
  planStatus.textContent = message ?? '';
  if (transient) {
    planStatusTimer = setTimeout(() => {
      planStatus.textContent = '';
    }, 2_500);
  }
}

/** Save a preference, then re-read the figures it changes. */
async function saveBilling(patch) {
  setPlanStatus('saving…');
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
    render();
    setPlanStatus('saved', { transient: true });
  } catch (err) {
    // Deliberately not `state.error`: that replaces the entire page with "the
    // server did not answer", which is a drastic response to one preference
    // failing to write while every figure on screen is still perfectly good.
    setPlanStatus(`could not save — ${err.message}`);
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
        // Named rather than pointed at. "The figure on the left" and "the one
        // beside it" describe a three-column grid, and below 720px the cells
        // stack — so on a phone the sentence was directing the reader at
        // positions that no longer existed.
        'not dollars. <strong>At API list rates</strong> is computed from published rates; ' +
        `<strong>your plan</strong> is the price you set below. ${authSentence}` +
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
  const number = (label, value, placeholder, min, commit, step = '1') =>
    h(
      'label.search',
      {},
      h('span.faint', { style: { fontSize: '11px' } }, label),
      h('input', {
        type: 'number',
        min,
        /**
         * A price is not a whole number of dollars.
         *
         * `type="number"` defaults to `step="1"`, which made every real
         * non-integer plan price — an annual tier billed at $17/mo, a
         * grandfathered rate, anything converted out of another currency —
         * fail validation the moment it loaded, and made the spinner arrows
         * round it away. Seats and months are genuinely whole; money is not.
         */
        step,
        inputmode: step === '1' ? 'numeric' : 'decimal',
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
      number(
        '$/mo',
        period.monthlyOverride,
        String(listPrice),
        '0',
        (v) => patchPeriod(index, { monthlyOverride: v }),
        '0.01',
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
      planStatus,
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
  const { unpriced, inferredSessions, fallbackPricedSessions } = state.spend;
  if (!unpriced?.sessions && !inferredSessions && !fallbackPricedSessions) return null;

  const box = h('div.card.caveats');

  if (inferredSessions > 0) {
    box.append(
      h('p', {
        html:
          `<strong>${inferredSessions}</strong> ` +
          `${inferredSessions === 1 ? 'session was priced at its' : 'sessions were priced at their'} ` +
          "tier's published rate — the exact model id is not in this app's catalog, " +
          'so the figure is an estimate rather than a rate card.',
      }),
    );
  }

  if (fallbackPricedSessions > 0) {
    // A different guess from the one above, and a larger one: there was no tier
    // in the id to reason from, so the rate was borrowed from the rest of the
    // session. Said separately rather than folded into the inferred count,
    // because the two are not equally confident.
    box.append(
      h('p', {
        html:
          `<strong>${fallbackPricedSessions}</strong> ${fallbackPricedSessions === 1 ? 'session used a model' : 'sessions used models'} ` +
          'this catalog cannot price at all — a gateway or proxy id names no tier to work from. Those ' +
          'requests are billed at the rate the rest of their session ran at, which is an assumption ' +
          'rather than a published price.',
      }),
    );
  }

  if (unpriced?.sessions > 0) {
    // A session with no model at all is the common case here — an aborted run
    // that never reached the API. "No rate is known for the model recorded" is
    // the wrong sentence for it, because no model was recorded.
    const reason = unpriced.models.length
      ? `no rate is known for ${unpriced.models.map(esc).join(', ')}`
      : `${unpriced.sessions === 1 ? 'it records' : 'they record'} no model that can be priced`;
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
          `not in this total: ${reason}. ${impact}`,
      }),
    );
  }

  return box;
}

/* ---------------------------------------------------------------- *
 * The cuts
 * ---------------------------------------------------------------- */

/**
 * A bar wide enough to see, unless there is nothing to see.
 *
 * A share of the largest row is a fraction, and on a real index the smallest
 * rows are tiny fractions: Sonnet 5 at $0.94 beside Opus 5 at $1,540 came out
 * **0.39px wide**, and Haiku 4.5 at $0.10 came out 0.04px — rows carrying real
 * money, drawn as an empty track. The floor is the same idea the day chart
 * already uses, and it stops at the same place: a row that genuinely cost
 * nothing keeps an empty track, because a 2px stub there would claim spending
 * that did not happen.
 */
function barWidth(fraction) {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0';
  return `max(2px, ${fraction * 100}%)`;
}

function barRow({ name, title, pill, meta, sub, width, value, share, tokens }) {
  return h(
    'div.bar-row',
    {},
    h(
      'div',
      {},
      h(
        'div.label',
        {},
        // `.name` is `text-overflow: ellipsis`, so a name wide enough to clip
        // needs somewhere to be read in full. Only where that can happen:
        // the component labels are written in this file and always fit, and a
        // tooltip repeating text already fully on screen is noise.
        h('span.name', { title }, name),
        pill && h('span.pill', {}, pill),
        meta && h('span.faint', { style: { fontSize: '11px' } }, meta),
      ),
      h(
        'div.bar-track',
        {},
        h('div.bar-fill', { style: { width: barWidth(width) } }),
      ),
      sub && h('div.sub', {}, sub),
      tokens,
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
        // Not every component is tokens: web search is billed per search, and
        // labelling its count "tokens" would be the page stating a falsehood
        // about what was charged.
        meta: `${compact(r.count)} ${r.unit ?? 'tokens'}`,
        sub: r.hint,
        width: r.cost / max,
        value: money(r.cost),
        share: percent(r.share),
      }),
    ),
  );
}

/**
 * The by-model and by-project rows.
 *
 * These carry the same token strip the session rows do. A model row showing only
 * a dollar figure invites exactly one question — why is *that* one the expensive
 * one — and cannot answer it: output at twenty times the input rate and a cache
 * being rebuilt rather than read are completely different stories that look
 * identical in a single total.
 */
function buckets(rows, total) {
  const max = Math.max(1, ...rows.map((r) => r.cost));
  return h(
    'div.rows',
    {},
    ...rows.map((r) =>
      barRow({
        name: r.name ?? r.id,
        title: r.name ?? r.id,
        meta: plural(r.sessions, 'session'),
        sub: r.path ? h('span.mono.faint', {}, shortPath(r.path)) : null,
        width: r.cost / max,
        value: money(r.cost),
        share: percent(total > 0 ? r.cost / total : 0),
        tokens: tokenStrip(r),
      }),
    ),
  );
}

/* ---------------------------------------------------------------- *
 * The session browser
 *
 * The other four cuts are a dozen-odd rows each and fit on screen whole. This
 * one has a row per session — hundreds of them on a machine that has been
 * running agents for a while — so it is the only cut that needs controls, and
 * the controls exist so the list can stay *complete*. Truncating to a top
 * twelve was the previous answer, and it made the by-session figures disagree
 * with every other number on the page.
 * ---------------------------------------------------------------- */

const SESSION_SORTS = [
  { id: 'cost', label: 'Cost', of: (s) => s.cost },
  { id: 'recent', label: 'Recent', of: (s) => s.endedAt },
  { id: 'output', label: 'Output', of: (s) => s.output },
  { id: 'tokens', label: 'Tokens', of: (s) => s.tokens },
  { id: 'requests', label: 'Requests', of: (s) => s.requests },
];

/** How many rows a click reveals. */
const SESSION_PAGE = 25;

function day(ms) {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * When a session ran — and, when that is not a single answer, how long a stretch
 * it covers.
 *
 * A transcript records first and last activity, which is *not* how long the
 * session ran: resuming one a week later is ordinary, and the first draft of this
 * printed the gap as a bare "287h 54m" beside the request count, where it reads
 * as twelve days of elapsed work. It was twelve days of wall clock containing a
 * few hours of it.
 *
 * So an elapsed figure is only shown when it is one: within a single local day
 * it is a duration, and across days it becomes a date range, which cannot be
 * misread as time spent. Local days, like everywhere else here — `toISOString`
 * would file an evening session under tomorrow east of Greenwich.
 */
function when(startedAt, endedAt) {
  const ended = day(endedAt);
  if (!ended) return null;
  const started = day(startedAt);
  if (started && started !== ended) return `${started} → ${ended}`;

  const mins = Math.round((endedAt - startedAt) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return ended;
  if (mins < 60) return `${ended} · ${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${ended} · ${mins % 60 ? `${hrs}h ${mins % 60}m` : `${hrs}h`}`;
}

/**
 * The four token kinds behind the row's dollar figure, plus searches when there
 * were any.
 *
 * Every cost on this page is a token count times a published rate, and until now
 * the page showed only one side of that multiplication. Printing the counts is
 * what makes a row checkable rather than merely believable — and the four are
 * kept apart because they are billed at four different multipliers, so a single
 * "tokens" total would hide the entire reason two sessions of the same size cost
 * different amounts.
 */
function tokenStrip(s) {
  const cells = [
    ['in', s.input],
    ['out', s.output],
    ['cache read', s.cacheRead],
    ['cache write', s.cacheWrite],
  ];
  // Searches are not tokens and are billed per search, so the label says so
  // rather than letting it sit unmarked in a row of token counts.
  if (s.searches > 0) cells.push(['searches', s.searches]);
  return h(
    'div.tokens',
    {},
    ...cells.map(([label, n]) =>
      h(
        'span.token-cell',
        { title: `${label}: ${Number(n ?? 0).toLocaleString()}` },
        h('span.token-key', {}, label),
        h('span.token-val', {}, compact(n ?? 0)),
      ),
    ),
  );
}

function sessionRow(s, max) {
  const facts = [
    s.project,
    // Only when there is a fleet. On one machine every row would carry the same
    // word, which is noise in a line that is already five facts long.
    state.spend?.bySource?.length > 1 && s.source ? `agent ${s.source}` : null,
    s.requests ? plural(s.requests, 'request') : null,
    when(s.startedAt, s.endedAt),
    `cache ${percent(s.cacheHitRate, 1)}`,
    s.contextRatio != null ? `context peak ${percent(s.contextRatio)}` : null,
  ].filter(Boolean);

  return h(
    'div.bar-row.session-row',
    {},
    h(
      'div',
      {},
      h(
        'div.label',
        {},
        // Session titles clip more often than anything else here: they are
        // whatever the user typed first, truncated to 80 characters by the
        // scanner and then to the column width by CSS.
        h('span.name', { title: s.name }, s.name),
        s.model && h('span.pill', {}, s.model),
        // A session billed at more than one rate is not describable by the pill
        // beside it, so it says how many rather than implying the one.
        s.models > 1 && h('span.pill', { title: 'Billed across more than one rate' }, `×${s.models}`),
        s.inferred && h('span.pill.warn-pill', { title: 'Priced at its tier’s list rate' }, 'inferred'),
        s.fallbackPriced &&
          h(
            'span.pill.warn-pill',
            { title: 'Some requests here named a model with no published rate, and were billed at this session’s rate' },
            'borrowed rate',
          ),
      ),
      h('div.bar-track', {}, h('div.bar-fill', { style: { width: barWidth(s.cost / max) } })),
      h('div.sub', {}, facts.join(' · ')),
      tokenStrip(s),
    ),
    h(
      'div.amount',
      {},
      h('div.value', {}, money(s.cost)),
      h('div.share', {}, percent(s.share, 1)),
    ),
  );
}

/**
 * The filter box and the list live outside the render tree.
 *
 * `render()` replaces `#root` wholesale, so a filter input rebuilt on every
 * keystroke loses the caret on the first character typed into it. The share box
 * above solves the same problem the same way; this follows it rather than
 * inventing a second idiom.
 */
const sessionFilter = h('input', {
  type: 'search',
  placeholder: 'Filter by session, project or agent…',
  'aria-label': 'Filter sessions',
  oninput: () => {
    // A new search is a new list, so the reveal starts over — otherwise
    // filtering down to three rows still claims 25 are shown.
    state.sessions.limit = SESSION_PAGE;
    paintSessions();
  },
});
const sessionBody = h('div.rows');
const sessionFoot = h('div.session-foot');

/**
 * The sort row's container, and why it needs one.
 *
 * `segmented` bakes the selected id into its buttons when it builds, so changing
 * the sort means rebuilding them — and `paintSessions` was only repainting the
 * list, which is how the highlight could stay on "Cost" while the rows reordered
 * underneath it. This wrapper is the thing that stays in the tree across those
 * rebuilds. `display: contents` keeps it out of the flex layout, so the buttons
 * sit in `.session-tools` exactly as if they were a direct child of it.
 */
const sessionSort = h('div.sort-slot');

function paintSort() {
  sessionSort.replaceChildren(
    segmented(SESSION_SORTS, state.sessions.sort, (id) => {
      state.sessions.sort = id;
      // A new order is a new list, so the reveal starts from the top of it.
      state.sessions.limit = SESSION_PAGE;
      paintSessions();
    }),
  );
}

function matchingSessions() {
  const q = sessionFilter.value.trim().toLowerCase();
  const rows = state.spend?.bySession ?? [];
  const filtered = q
    ? rows.filter(
        (s) =>
          String(s.name ?? '').toLowerCase().includes(q) ||
          String(s.project ?? '').toLowerCase().includes(q) ||
          String(s.source ?? '').toLowerCase().includes(q),
      )
    : rows;
  const sort = SESSION_SORTS.find((s) => s.id === state.sessions.sort) ?? SESSION_SORTS[0];
  return [...filtered].sort((a, b) => sort.of(b) - sort.of(a));
}

/**
 * Repaint the list alone.
 *
 * Filtering and revealing do not change any other number on the page, and a full
 * `render()` for a keystroke would rebuild the billing panel and repaint the
 * share canvas to show the same picture.
 */
function paintSessions() {
  const rows = matchingSessions();
  const shown = rows.slice(0, state.sessions.limit);
  /**
   * The scale is every row the filter matched — **not** every row on screen.
   *
   * Taking it from the visible slice meant "Show more" could redraw bars that
   * were already there: reveal a row more expensive than anything above it (easy
   * under any sort but cost) and the whole list rescales, so a figure the reader
   * had already taken in silently changes length. A bar is a comparison, and the
   * thing it is compared against cannot depend on how far down the page someone
   * has clicked.
   *
   * Filtering still rescales, and should: a filter changes the question, so it
   * changes what "the biggest" means. Revealing more of the same answer does not.
   */
  const max = Math.max(1e-9, ...rows.map((r) => r.cost));

  // The sort row is rebuilt here rather than once in `bySession()`, because
  // `segmented` bakes the selection in at build time — leaving it out meant
  // clicking a sort reordered the list while the highlight stayed on "Cost".
  paintSort();

  sessionBody.replaceChildren(
    ...(shown.length
      ? shown.map((s) => sessionRow(s, max))
      : [h('div.empty', {}, h('strong', {}, 'No session matches that'))]),
  );

  const shownCost = shown.reduce((n, s) => n + s.cost, 0);
  const allCost = rows.reduce((n, s) => n + s.cost, 0);
  // `replaceChildren` is the native DOM call, not `h()`, so it does not skip a
  // falsy child the way the builder does — it stringifies it. Dropping the
  // button with `&&` printed the word "false" in the footer of every fully
  // revealed list, which is what the filter below is for.
  const foot = [
    h(
      'span.faint',
      {},
      // Says what is on screen *and* what it is out of, in both rows and
      // dollars. The old list said neither, which is how twelve rows could look
      // like the whole story.
      `${shown.length} of ${plural(rows.length, 'session')} · ${money(shownCost)} of ${money(allCost)}`,
    ),
    shown.length < rows.length
      ? h(
          'button.link-button',
          {
            onclick: () => {
              state.sessions.limit += SESSION_PAGE * 3;
              paintSessions();
            },
          },
          `Show ${Math.min(SESSION_PAGE * 3, rows.length - shown.length)} more`,
        )
      : null,
  ].filter(Boolean);
  sessionFoot.replaceChildren(...foot);
}

/**
 * Deliberately not links: this page is the whole application, and a row that
 * looks clickable but opens nothing is worse than a row that never claimed to.
 */
function bySession() {
  paintSessions();
  return h(
    'div',
    {},
    h(
      'div.session-tools',
      {},
      h('label.search', {}, icon('search', 14), sessionFilter),
      sessionSort,
    ),
    sessionBody,
    sessionFoot,
  );
}

/** How many days of columns the chart shows at once. */
const DAY_WINDOW = 30;

/**
 * The last thirty calendar days — including the ones you did not work.
 *
 * `byDay` now carries a row per day across the whole span rather than only the
 * days something ran (see `spendBreakdown`), so these columns are an even time
 * axis and a gap in them is a real gap. The scale is the maximum of what is
 * *shown*: taking it from the full history made the visible bars a fraction of
 * their height with nothing on screen to explain why.
 *
 * Thirty columns is a window, and a window is a truncation — which is the one
 * thing every cut here has to declare rather than perform quietly. The payload
 * spans the whole history, so on a longer one this chart was showing a fraction
 * of the money under a heading that said "By day" and nothing that said which
 * fraction. The footer now names both figures, the way the session list does;
 * see invariant 1 in CLAUDE.md for why "complete" and "says what it leaves out"
 * are the same requirement.
 */
function byDay(rows) {
  // Reachable with sessions on disk: if every one of them used a model nothing
  // could price, there are no day buckets to draw. Returning a childless node
  // lets `whereItWent` fall through to "Nothing to split here yet" instead of
  // rendering an empty chart under two blank axis labels.
  if (!rows.length) return h('div');
  const recent = rows.slice(-DAY_WINDOW);
  const max = Math.max(1, ...recent.map((r) => r.cost));
  // The columns say everything through `title`, which is a hover — no use on a
  // touch screen and none at all to a screen reader. The axis and footer below
  // already carry the span and the totals in text; this gives the picture
  // itself the one sentence that makes it not a gap in the page.
  const spent = recent.filter((d) => d.cost > 0).length;
  const chart = h(
    'div.activity',
    {
      role: 'img',
      'aria-label':
        `Daily spend from ${recent[0]?.date ?? ''} to ${recent[recent.length - 1]?.date ?? ''}. ` +
        `${plural(spent, 'day')} with spend, ${plural(recent.length - spent, 'idle day')}, ` +
        `peaking at ${money(max)}.`,
    },
    ...recent.map((d) =>
      h(
        'div.activity-col',
        {
          title: d.sessions
            ? `${d.date} · ${money(d.cost)} · ${plural(d.sessions, 'session')}`
            : `${d.date} · nothing ran`,
        },
        h('div.activity-bar', {
          // An idle day is a flat baseline, not a 2% stub that reads as a
          // little bit of spend.
          class: d.cost > 0 ? null : 'idle',
          /**
           * 4px, and in pixels rather than percent, so a day that cost
           * something is visibly taller than the day beside it that cost
           * nothing. The floor used to be `2%` of a 98px column — about 2px,
           * which is exactly the idle tick's height, leaving colour as the only
           * thing telling them apart at the size where it is hardest to see.
           * The floor states that a day happened, not how much it cost, and
           * that is true of every day it applies to.
           */
          style: { height: d.cost > 0 ? `max(4px, ${(d.cost / max) * 100}%)` : '2px' },
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

  const shownCost = recent.reduce((n, d) => n + d.cost, 0);
  const allCost = rows.reduce((n, d) => n + d.cost, 0);
  const foot =
    rows.length > recent.length
      ? h(
          'div.session-foot',
          {},
          h(
            'span.faint',
            {},
            `${recent.length} of ${plural(rows.length, 'day')} · ${money(shownCost)} of ${money(allCost)}`,
          ),
          h('span.faint', {}, 'the chart shows the most recent days'),
        )
      : null;

  return h('div', {}, chart, axis, foot);
}

/**
 * Agent rows, with the one that is not a container named as one.
 *
 * `local` is the machine serving this page, and calling it `local` in a list
 * beside `build-01` reads as another container. The id stays the id; only the
 * label changes, and only here — see the invariant about prose in the UI saying
 * what a thing is.
 */
function agentRows(rows = []) {
  return rows.map((r) => (r.id === 'local' ? { ...r, name: 'This machine' } : r));
}

function whereItWent() {
  const data = state.spend;
  // A cut with nothing to show is not offered. `state.cut` can still be
  // pointing at one — the fleet was there a moment ago and a rescan found it
  // gone — so the picker falling back is what stops that rendering as a card
  // with no body and no selected tab.
  const cuts = CUTS.filter((c) => !c.when || c.when(data));
  if (!cuts.some((c) => c.id === state.cut)) state.cut = cuts[0].id;
  const cut = cuts.find((c) => c.id === state.cut);

  const picker = segmented(cuts, state.cut, (id) => {
    state.cut = id;
    render();
  });

  let body;
  if (state.cut === 'components') body = components(data.components);
  else if (state.cut === 'bySource') body = buckets(agentRows(data.bySource), data.total);
  else if (state.cut === 'byDay') body = byDay(data.byDay);
  // Checked before building: the browser is a filter box and a sort row around
  // the list, so it is never childless and would never reach the empty state
  // below on its own.
  else if (state.cut === 'bySession') body = data.bySession?.length ? bySession() : h('div');
  else body = buckets(data[state.cut], data.total);

  if (!body.childElementCount) {
    body = h('div.empty', {}, h('strong', {}, 'Nothing to split here yet'));
  }

  return card('Where the money went', cut?.hint, picker, body);
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
// Announced, not just shown: "Post copied to the clipboard" is the entire
// feedback for a button whose effect is otherwise invisible.
const shareStatus = h('span.share-status', { 'aria-live': 'polite' });
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
  const angles = segmented(ANGLES, state.share.angle, (id) => {
    state.share.angle = id;
    state.share.text = null;
    render();
  });

  const formats = segmented(FORMATS, state.share.format, (id) => {
    state.share.format = id;
    render();
  });

  const tones = segmented(
    [
      { id: 'short', label: 'Short', note: 'Fits X and Bluesky.' },
      { id: 'long', label: 'Long', note: 'For LinkedIn, Reddit and Instagram captions.' },
    ],
    state.share.tone,
    (id) => {
      state.share.tone = id;
      // A tone is a starting point, not a filter over the user's words:
      // switching it rewrites the box, so an edit is never half-applied.
      state.share.text = null;
      render();
    },
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
  subtitle.textContent =
    meta.found && meta.sessions
      ? `${plural(meta.sessions, 'session')} across ${plural(meta.workspaces, 'project')} · indexed ${ago(meta.scannedAt)}`
      : 'What your agent would have cost';

  /**
   * Three states, not two.
   *
   * `found` only ever meant "the directory is there", so a machine where Claude
   * Code has been installed but has not written a transcript yet — a fresh
   * install, or a `~/.claude/projects` somebody cleared out — fell through to
   * the full dashboard and rendered a comparison of zeros: six $0 component
   * rows, a chart with no columns and blank axis labels, and a plan panel
   * arguing about nothing. The empty state below was already written and simply
   * never fired for it.
   *
   * The two cases want different sentences, too. One is "I could not find where
   * your transcripts live"; the other is "I found where they live and there are
   * none yet", and only the first is worth mentioning `CLAUDE_HOME` for.
   */
  if (!meta.found || !meta.sessions) {
    root.append(
      meta.found
        ? h(
            'div.card.empty',
            {},
            h('strong', {}, 'No sessions recorded yet'),
            h('span', {}, 'Claude Code keeps its transcripts here, and there are none in it:'),
            h('code', {}, meta.claudeDir ?? '~/.claude/projects'),
            h(
              'span',
              {},
              'Run Claude Code once and press re-read. Every figure this page shows is derived ' +
                'from those files, so there is nothing to price until one exists.',
            ),
          )
        : h(
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
  // The blanket `prefers-reduced-motion` rule in styles.css cannot reach this:
  // it flattens CSS animations and transitions, and a scroll asked for in
  // JavaScript is neither. Asked for explicitly, so the one animation on the
  // page that is not declarative honours the same preference as the rest.
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  shareBox?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
  shareBox?.focus({ preventScroll: true });
});

const rescan = document.getElementById('rescan');
rescan.append(icon('refresh'));
rescan.addEventListener('click', async () => {
  rescan.classList.add('busy');
  try {
    await json('/api/refresh', { method: 'POST' });
    await load({ fresh: true });
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
