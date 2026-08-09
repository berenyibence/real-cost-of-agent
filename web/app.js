/**
 * Spend, openable.
 *
 * The headline number is the top of a tree. Each cut re-splits the same dollars
 * a different way, and the subscription panel answers the question the token
 * figure alone cannot: did you actually pay this?
 *
 * No framework, no build step. The page is one screen with one shape of data,
 * and everything below is plain DOM.
 */

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
  refresh:
    '<path d="M20 11a8 8 0 0 0-13.7-5.4L3 9"/><path d="M4 13a8 8 0 0 0 13.7 5.4L21 15"/><path d="M3 4v5h5M21 20v-5h-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
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
 * The subscription panel
 *
 * The distinction between a computed figure and money actually charged.
 * ---------------------------------------------------------------- */

function billingPanel() {
  const b = state.spend.billing;
  const config = state.billing?.config;
  const plans = state.billing?.plans ?? [];
  const subscription = b.authMode === 'subscription';

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
    cell('coin', 'API-equivalent', money(b.apiEquivalent), 'what these tokens cost at list rates'),
    cell(
      'plug',
      'You actually paid',
      subscription ? money(b.subscriptionCost) : money(b.apiCreditsSpent),
      subscription
        ? `${b.plan.name} · ${plural(b.months, 'month')} of use`
        : 'metered API credits',
      subscription ? 'var(--running)' : null,
    ),
    cell(
      'zap',
      subscription ? 'Value multiple' : 'Credits spent',
      subscription && b.ratio ? `${b.ratio.toFixed(1)}×` : money(b.apiCreditsSpent),
      subscription && b.ratio
        ? `every $1 of plan bought $${b.ratio.toFixed(2)} at API rates`
        : 'real charges against your API balance',
      'var(--accent-text)',
    ),
  );

  const note =
    subscription &&
    h(
      'div.billing-note',
      {},
      icon('check', 13),
      h(
        'div',
        {
          html:
            '<strong>API credits spent: $0.</strong> Your usage authenticates over OAuth, so it draws ' +
            'against plan limits rather than metered credits. The figure above is what the same work ' +
            '<em>would</em> have cost on the API — value received, not money charged.' +
            (b.saved > 0
              ? ` Against a ${b.plan.name} subscription over ${plural(b.months, 'month')}, ` +
                `that is <strong>${money(b.saved)}</strong> of usage beyond what the plan cost.`
              : ''),
        },
      ),
    );

  const select = h(
    'select.select',
    {
      onchange: (e) => saveBilling({ planId: e.target.value, monthlyOverride: null }),
    },
    ...plans.map((p) =>
      h(
        'option',
        { value: p.id, selected: config?.planId === p.id },
        `${p.name}${p.monthly ? ` — $${p.monthly}/mo` : ''}`,
      ),
    ),
  );

  const number = (label, value, placeholder, onblur) =>
    h(
      'label.search',
      {},
      h('span.faint', { style: { fontSize: '11px' } }, label),
      h('input', {
        type: 'number',
        min: label === 'seats' ? '1' : '0',
        placeholder,
        value: value ?? '',
        onblur,
      }),
    );

  const config_ = h(
    'div.billing-config',
    {},
    h(
      'span.faint',
      { style: { fontSize: '11.5px' } },
      'Plan tier is not recorded anywhere on disk, so set it here. Prices are editable — published ' +
        'pricing changes and this app will not show a stale figure as fact.',
    ),
    h(
      'div.billing-controls',
      {},
      select,
      number('$/mo', config?.monthlyOverride, 'override', (e) =>
        saveBilling({ monthlyOverride: e.target.value === '' ? null : Number(e.target.value) }),
      ),
      number('seats', config?.seats ?? 1, '1', (e) =>
        saveBilling({ seats: Math.max(1, Number(e.target.value) || 1) }),
      ),
      state.saving && h('span.faint', { style: { fontSize: '11px' } }, 'saving…'),
      !state.saving && state.saved && h('span.faint', { style: { fontSize: '11px' } }, 'saved'),
    ),
    b.authEvidence &&
      h(
        'div.faint.mono',
        { style: { fontSize: '10.5px', marginTop: '8px' } },
        `detection: ${b.authEvidence}`,
      ),
  );

  const hint = subscription
    ? 'You are on a subscription'
    : b.authMode === 'api'
      ? 'Billing to API credits'
      : 'Auth mode unknown';

  return card('Subscription vs API', hint, null, grid, note, config_);
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
    : 'What it cost, what you paid, and where it went';

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
}

/* ---------------------------------------------------------------- *
 * Chrome
 * ---------------------------------------------------------------- */

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
  localStorage.setItem('agent-spend-theme', next);
  paintThemeIcon();
});
paintThemeIcon();

load();
