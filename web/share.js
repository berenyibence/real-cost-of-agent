/**
 * Real Cost of Agent — the share card.
 *
 * The page already knows the one number people want to say out loud. This turns
 * it into a post and an image, without any of it leaving the machine until a
 * person clicks a link.
 *
 * Three rules shape everything below.
 *
 * 1. **Only aggregates cross this boundary.** `shareFacts` is the single door
 *    between the spend payload and anything shareable, and it copies scalars —
 *    dollars, counts, percentages, a plan's product name. Project names, file
 *    paths and session titles are not in the shape it returns, so no amount of
 *    editing downstream can put them in a post. `test/share.test.js` asserts it
 *    against a payload seeded with paths in every field that has one.
 * 2. **Nothing here opens a socket.** The image is painted on a canvas and read
 *    back as a blob; the platform links are `href`s the user clicks. That is
 *    still the only outbound traffic this project can produce, and it takes a
 *    deliberate click on a named button to produce it.
 * 3. **No third-party logos.** Every platform is a text label. Remote logos
 *    would mean a network request, and bundled ones mean shipping other
 *    companies' trademarks — the labels cost nothing and read fine.
 */

export const PRODUCT = 'Real Cost of Agent';
export const TAGLINE = 'What your agent would have cost.';
export const REPO_URL = 'https://github.com/berenyibence/real-cost-of-agent';
export const REPO_SHORT = 'github.com/berenyibence/real-cost-of-agent';
export const HASHTAGS = '#ClaudeCode #AI #DevTools #OpenSource #AIAgents';

/** The logo mark, as SVG path data — drawn by the page, the canvas and the favicon alike. */
export const MARK_PATHS = [
  // A receipt: straight sides, a torn bottom edge.
  'M5 2.5h14v17.4l-2.33 1.6-2.34-1.6-2.33 1.6-2.33-1.6-2.34 1.6L5 19.9Z',
  // The figure printed on it.
  'M14.4 8.4A2.6 2.6 0 0 0 12 7.2c-1.45 0-2.6.8-2.6 1.95s1.15 1.95 2.6 1.95 2.6.8 2.6 1.95-1.15 1.95-2.6 1.95a2.6 2.6 0 0 1-2.4-1.2',
  'M12 5.6v10.8',
];

/** Image sizes, and what each one is actually for. */
export const FORMATS = [
  { id: 'landscape', label: 'Landscape', w: 1200, h: 630, note: 'X · LinkedIn · Facebook' },
  { id: 'portrait', label: 'Portrait', w: 1080, h: 1350, note: 'Instagram · Threads' },
  { id: 'square', label: 'Square', w: 1080, h: 1080, note: 'Instagram grid' },
];

/**
 * Brand ramp, indigo through to the green the page already uses for "you did
 * not actually pay this". Keyed by component id rather than by position,
 * because the rows arrive sorted by cost and a colour that moves between
 * screenshots is a colour that means nothing.
 */
const COMPONENT_COLORS = {
  output: '#7c87ff',
  input: '#8b7bff',
  cacheWrite1h: '#4fb2e0',
  cacheWrite5m: '#43c3c6',
  cacheRead: '#34d399',
};

const BRAND_FROM = '#7c87ff';
const BRAND_TO = '#34d399';

/* ---------------------------------------------------------------- *
 * Formatting
 * ---------------------------------------------------------------- */

const finite = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Money for a headline, which is a different job from money in a table.
 *
 * The page abbreviates past $10k because a column has to stay narrow. A post
 * has room, and "$12,480" is the sentence people repeat — `$12.5k` reads like a
 * rounding someone else did.
 */
export function dollars(n) {
  const v = finite(n);
  if (v <= 0) return '$0';
  if (v < 10) return `$${v.toFixed(2)}`;
  return `$${group(Math.round(v))}`;
}

const plural = (n, word) => `${group(n)} ${word}${n === 1 ? '' : 's'}`;

const pct = (share) => `${Math.round(finite(share) * 100)}%`;

/* ---------------------------------------------------------------- *
 * Facts — the privacy boundary
 * ---------------------------------------------------------------- */

/**
 * Everything a post is allowed to know.
 *
 * Written as an explicit allowlist rather than a redaction pass over the spend
 * payload: a new field added to `/api/spend` should have to be deliberately
 * invited into a post, and a redactor is the design where it arrives by
 * default and somebody notices later.
 */
export function shareFacts(spend) {
  const billing = spend?.billing ?? {};
  const meta = spend?.meta ?? {};
  const total = finite(spend?.total);
  const planCost = finite(billing.planCost);
  const hasPlan = planCost > 0;
  const ratio = finite(billing.ratio);
  const months = Math.max(1, Math.round(finite(billing.months)) || 1);

  return {
    total,
    /** There is a plan to compare against. Not "the plan is winning". */
    hasPlan,
    /** Authenticating with an API key, so list rates are the actual bill. */
    metered: billing.metered === true,
    /** A product name, e.g. "Claude Max 20×". Never a project or a path. */
    planName: hasPlan ? String(billing.plan?.name ?? '') : null,
    /** What the plan costs over the months the transcripts span. */
    planCost,
    /** What the plan costs per month, which is the figure people actually know. */
    planMonthly: months > 0 ? planCost / months : 0,
    /**
     * Signed, and that is the point. Positive is usage the plan did not charge
     * for; negative is a plan that cost more than the work was worth. A share
     * card that can only ever report the first one is an advertisement.
     */
    saved: hasPlan ? total - planCost : 0,
    ratio: hasPlan && ratio > 0 ? ratio : null,
    /** What this habit runs per month at list rates — the "could I afford it?" number. */
    perMonth: total / months,
    verdict: String(billing.verdict ?? 'unknown'),
    months,
    sessions: Math.max(0, Math.round(finite(meta.sessions))),
    projects: Math.max(0, Math.round(finite(meta.workspaces))),
    split: (spend?.components ?? [])
      .filter((c) => finite(c.cost) > 0)
      .map((c) => ({ id: String(c.id ?? ''), label: String(c.label ?? ''), share: finite(c.share) })),
  };
}

/** There is nothing worth posting about an empty index. */
export function shareable(spend) {
  return Boolean(spend?.meta?.found) && finite(spend?.total) > 0;
}

/* ---------------------------------------------------------------- *
 * The words
 * ---------------------------------------------------------------- */

/** The clause naming the plan, which is what makes the number mean anything. */
function planClause(f) {
  const on = f.planName ? ` on ${f.planName}` : '';
  return `${dollars(f.planCost)}${on} over ${plural(f.months, 'month')}`;
}

/** The gap, said in whichever direction it actually runs. */
function gapClause(f) {
  if (!f.hasPlan) return '';
  if (f.saved > 0) return `${dollars(f.saved)} of usage I was never billed for`;
  if (f.saved < 0) return `${dollars(-f.saved)} more than the work was worth`;
  return 'exactly what it cost';
}

const behind = (f) => f.verdict === 'api-ahead';

/**
 * The angles.
 *
 * The same numbers persuade different people for different reasons, and one
 * post cannot do all of it. Somebody on Max at $200 is asking whether it is
 * worth it; somebody eyeing the API is asking whether they could afford the
 * same habit metered; somebody on Pro at $20 mostly enjoys the multiple; and a
 * technical audience would rather argue about the cache split than hear about
 * anyone's savings.
 *
 * Each angle supplies the words *and* the headline on the card, so picking one
 * changes both and they cannot drift apart. Every angle names the gap — that is
 * the number people repeat — and every angle has to survive the gap running the
 * other way. A card that can only say "my plan is great" is an advertisement,
 * and it would make the ones that say something true less believable.
 */
export const ANGLES = [
  {
    id: 'value',
    label: 'Value',
    note: 'What every $1 of plan bought. Strongest when the multiple is large.',
    eyebrow: (f) => (f.hasPlan ? 'WHAT EVERY $1 OF PLAN BOUGHT' : 'CLAUDE CODE, PRICED AT API LIST RATES'),
    number: (f) => (f.ratio ? `${f.ratio.toFixed(1)}×` : dollars(f.total)),
    headline: (f) => {
      if (!f.hasPlan) return `${dollars(f.total)} — what my Claude Code sessions would cost at API list rates.`;
      if (behind(f)) return `${f.ratio.toFixed(1)}× — my Claude Code plan did not pay for itself.`;
      return `${f.ratio.toFixed(1)}× — what my Claude Code plan actually returned.`;
    },
    caption: (f) => {
      if (!f.hasPlan) return `${plural(f.sessions, 'session')} across ${plural(f.projects, 'project')}.`;
      if (behind(f)) {
        return `${dollars(f.total)} of work at list rates, against ${planClause(f)} — ${gapClause(f)}.`;
      }
      return `${dollars(f.total)} at list rates, against ${planClause(f)} — ${gapClause(f)}.`;
    },
  },
  {
    id: 'saved',
    label: 'Saved',
    note: 'Leads with the dollars. The number people repeat.',
    eyebrow: (f) =>
      !f.hasPlan
        ? 'CLAUDE CODE, PRICED AT API LIST RATES'
        : behind(f)
          ? 'WHAT THE PLAN COST ABOVE METERED RATES'
          : 'USAGE BEYOND WHAT THE PLAN COST',
    number: (f) => (f.hasPlan ? dollars(Math.abs(f.saved)) : dollars(f.total)),
    headline: (f) => {
      if (!f.hasPlan) return `${dollars(f.total)} of Claude Code, at API list rates.`;
      if (behind(f)) return `My Claude Code plan cost ${dollars(-f.saved)} more than the work was worth.`;
      return `${dollars(f.saved)} of Claude Code I was never billed for.`;
    },
    caption: (f) =>
      f.hasPlan
        ? `${dollars(f.total)} at API list rates, against ${planClause(f)}.`
        : `${plural(f.sessions, 'session')} across ${plural(f.projects, 'project')}.`,
  },
  {
    id: 'runrate',
    label: 'Run rate',
    note: 'What the habit costs per month, metered. The "could I actually afford this?" angle.',
    eyebrow: () => 'WHAT THIS HABIT COSTS PER MONTH, METERED',
    number: (f) => `${dollars(f.perMonth)}/mo`,
    headline: (f) => {
      if (!f.hasPlan) return `My Claude Code habit runs ${dollars(f.perMonth)} a month at API list rates.`;
      if (behind(f)) {
        return `${dollars(f.perMonth)} a month of Claude Code, on a ${dollars(f.planMonthly)}-a-month plan.`;
      }
      return `${dollars(f.perMonth)} a month at API list rates. My plan is ${dollars(f.planMonthly)}.`;
    },
    caption: (f) => {
      if (!f.hasPlan) return `${plural(f.months, 'month')} of transcripts, priced at published rates.`;
      if (behind(f)) return `Metered would bill me ${dollars(-f.saved / f.months)} a month less at this rate of use.`;
      return `Against ${dollars(f.planMonthly)}/mo of ${f.planName}. Same work, ${f.ratio.toFixed(1)}× the price.`;
    },
  },
  {
    id: 'split',
    label: 'Breakdown',
    note: 'Where the money actually went. The one a technical audience argues with.',
    eyebrow: () => 'CLAUDE CODE, PRICED AT API LIST RATES',
    number: (f) => dollars(f.total),
    headline: (f) => {
      const top = f.split[0];
      if (!top) return `${dollars(f.total)} of Claude Code, priced from my own transcripts.`;
      return `${dollars(f.total)} of Claude Code — and ${pct(top.share)} of it was ${top.label.toLowerCase()}.`;
    },
    caption: (f) => {
      const split = f.split
        .slice(0, 3)
        .map((p) => `${p.label.toLowerCase()} ${pct(p.share)}`)
        .join(', ');
      if (!f.hasPlan) return split || `${plural(f.sessions, 'session')} priced at list rates.`;
      return `${split}. The plan cost ${dollars(f.planCost)} — ${gapClause(f)}.`;
    },
  },
];

const angleFor = (id) => ANGLES.find((a) => a.id === id) ?? ANGLES[0];

export function headline(f, angle = 'value') {
  return angleFor(angle).headline(f);
}

/**
 * The second line of a post: the context the headline assumes.
 *
 * `compact` drops the session and project counts. They are the least load-
 * bearing sentence here and the first thing worth losing when the post has to
 * fit — see `shareText`.
 */
export function subhead(f, angle = 'value', { compact = false } = {}) {
  const scale = compact ? '' : ` ${plural(f.sessions, 'session')} across ${plural(f.projects, 'project')}.`;
  // The plan's *name* is half the interest in the post — "$600" says nothing,
  // "$600 of Claude Max 20×" tells a reader which tier produced the number.
  const against = f.hasPlan ? `, against ${dollars(f.planCost)} of ${f.planName}` : '';

  if (angle === 'split') {
    const split = f.split
      .slice(0, compact ? 2 : 3)
      .map((p) => `${p.label.toLowerCase()} ${pct(p.share)}`)
      .join(', ');
    if (!f.hasPlan) return `${split}.${scale}`;
    return `${split}. The plan cost ${dollars(f.planCost)} — ${gapClause(f)}.${scale}`;
  }

  if (angle === 'runrate') {
    return f.hasPlan
      ? `${dollars(f.total)} of work over ${plural(f.months, 'month')}${against}.${scale}`
      : `${dollars(f.total)} over ${plural(f.months, 'month')}.${scale}`;
  }

  return f.hasPlan
    ? `${dollars(f.total)} at API list rates over ${plural(f.months, 'month')}${against}.${scale}`
    : `${dollars(f.total)} at API list rates.${scale}`;
}

/** The one line under the big number on the card. */
export function imageCaption(f, angle = 'value') {
  return angleFor(angle).caption(f);
}

export function imageEyebrow(f, angle = 'value') {
  return angleFor(angle).eyebrow(f);
}

export function imageNumber(f, angle = 'value') {
  return angleFor(angle).number(f);
}

const CLOSER = `Priced from my own transcripts by ${PRODUCT}:`;

/**
 * A post.
 *
 * The short form is **fitted to 280 characters, not written and hoped for.**
 * Four angles times a plan that may be ahead or behind times numbers from $4 to
 * $987,654 is more combinations than anyone will re-count by hand, and the one
 * that overruns loses the end of the post — which is the link, the only part
 * with a job to do.
 *
 * So it degrades in a fixed order, dropping the least load-bearing thing first:
 * the session and project counts, then the sentence naming the tool, and only
 * ever the link last, by never dropping it at all.
 */
export function shareText(f, { tone = 'short', angle = 'value', limit = 280 } = {}) {
  if (tone === 'long') {
    return [
      headline(f, angle),
      '',
      'Claude Code writes a transcript of every session to your own disk, and every reply in it carries the exact token counts the API measured. Almost nobody adds them up.',
      '',
      `So: ${subhead(f, angle)} Split by model, by project and by day, with the cache traffic priced at the multipliers the API really bills.`,
      '',
      `${PRODUCT} is one Node command. No dependencies, no build step, no account, no API key, and nothing leaves the machine.`,
      '',
      'Free and open source, Apache-2.0:',
      REPO_URL,
      '',
      HASHTAGS,
    ].join('\n');
  }

  const head = headline(f, angle);
  const candidates = [
    [head, '', subhead(f, angle), '', CLOSER, REPO_SHORT],
    [head, '', subhead(f, angle, { compact: true }), '', CLOSER, REPO_SHORT],
    [head, '', subhead(f, angle, { compact: true }), '', REPO_SHORT],
    [head, '', REPO_SHORT],
  ].map((lines) => lines.join('\n'));

  return candidates.find((text) => text.length <= limit) ?? candidates[candidates.length - 1];
}

export function redditTitle(f, angle = 'value') {
  return `${PRODUCT} — I priced every Claude Code session on my disk. ${headline(f, angle)}`.slice(
    0,
    300,
  );
}

export function hackerNewsTitle() {
  return `Show HN: ${PRODUCT} – price your Claude Code transcripts locally, no account`;
}

/* ---------------------------------------------------------------- *
 * Where a post can go
 * ---------------------------------------------------------------- */

const enc = encodeURIComponent;

/**
 * The platforms, and an honest note about what each one will actually do.
 *
 * `prefills: false` is not a footnote. Facebook's sharer takes a URL and
 * nothing else, and Instagram has no web composer at all — a button that
 * pretends otherwise sends someone to an empty box wondering where their text
 * went. Both copy the text to the clipboard on the way out instead.
 */
export function shareTargets(f, { short, long, angle = 'value' } = {}) {
  const brief = short ?? shareText(f, { tone: 'short', angle });
  const full = long ?? shareText(f, { tone: 'long', angle });

  return [
    {
      id: 'x',
      label: 'X',
      href: `https://x.com/intent/post?text=${enc(brief)}`,
      prefills: true,
    },
    {
      id: 'bluesky',
      label: 'Bluesky',
      href: `https://bsky.app/intent/compose?text=${enc(brief)}`,
      prefills: true,
    },
    {
      id: 'linkedin',
      label: 'LinkedIn',
      href: `https://www.linkedin.com/feed/?shareActive=true&text=${enc(full)}`,
      prefills: true,
    },
    {
      id: 'threads',
      label: 'Threads',
      href: `https://www.threads.net/intent/post?text=${enc(brief)}`,
      prefills: true,
    },
    {
      id: 'reddit',
      label: 'Reddit',
      href: `https://www.reddit.com/submit?type=TEXT&title=${enc(redditTitle(f, angle))}&text=${enc(full)}`,
      prefills: true,
      note: 'Opens a self-post. r/ClaudeAI and r/LocalLLaMA are the on-topic ones.',
    },
    {
      id: 'hackernews',
      label: 'Hacker News',
      href: `https://news.ycombinator.com/submitlink?u=${enc(REPO_URL)}&t=${enc(hackerNewsTitle())}`,
      prefills: true,
      note: 'Submits the repository. Your numbers go in the comment, not the title.',
    },
    {
      id: 'facebook',
      label: 'Facebook',
      href: `https://www.facebook.com/sharer/sharer.php?u=${enc(REPO_URL)}`,
      prefills: false,
      note: 'Facebook only accepts the link. The text is copied to your clipboard — paste it.',
    },
    {
      id: 'instagram',
      label: 'Instagram',
      href: null,
      prefills: false,
      note: 'No web composer exists. Download the image, then paste the caption from your clipboard.',
    },
  ];
}

/* ---------------------------------------------------------------- *
 * The image
 * ---------------------------------------------------------------- */

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';

const font = (weight, size, family = SANS) => `${weight} ${size}px ${family}`;

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, radius);
  else {
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
}

/** Greedy wrap. The strings here are one or two lines; nothing needs Knuth. */
function wrap(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawMark(ctx, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.7;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const d of MARK_PATHS) ctx.stroke(new Path2D(d));
  ctx.restore();
}

/**
 * Paint the card.
 *
 * Every dimension is a fraction of the width, so one layout serves the
 * landscape, portrait and square crops rather than three near-copies drifting
 * apart. `scale` is a plain supersample: the file is downloaded and then
 * re-encoded by whichever platform receives it, and 1× text does not survive
 * that.
 */
export function paintShareCard(canvas, f, { format = 'landscape', scale = 2, angle = 'value' } = {}) {
  const spec = FORMATS.find((x) => x.id === format) ?? FORMATS[0];
  const { w, h } = spec;
  const tall = spec.id !== 'landscape';

  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = 'alphabetic';

  const pad = Math.round(w * 0.062);
  const colWidth = w - pad * 2;

  /**
   * Type scales with the crop, not with width alone.
   *
   * The tall crops are narrower than the landscape one and roughly twice as
   * deep. Sizing everything off `w` therefore made the *smallest* text on the
   * *largest* canvas, and a portrait card came out as a paragraph floating in
   * the middle of a lot of nothing.
   */
  const typeScale = spec.id === 'portrait' ? 1.42 : spec.id === 'square' ? 1.2 : 1;
  const u = w * typeScale;
  // The tall crops get a looser rhythm as well as bigger type. Filling 4:5 by
  // stretching gaps alone leaves a dense little block in a large empty frame —
  // the extra room wants extra *content*, which is what the vertical split
  // below is for, with the gaps opened just enough to let it breathe.
  const gap = h * (tall ? 0.026 : 0.022);

  /* ---- ground ---- */
  ctx.fillStyle = '#0a0c11';
  ctx.fillRect(0, 0, w, h);

  const glow = (cx, cy, r, color, alpha) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(10, 12, 17, 0)');
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  };
  glow(w * 0.12, h * 0.06, w * 0.72, BRAND_FROM, 0.2);
  glow(w * 0.94, h * 1.02, w * 0.66, BRAND_TO, 0.14);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, pad * 0.42, pad * 0.42, w - pad * 0.84, h - pad * 0.84, w * 0.022);
  ctx.stroke();

  /* ---- header ---- */
  const markSize = Math.round(u * 0.043);
  const headerY = pad;
  drawMark(ctx, pad, headerY, markSize, '#a5adff');

  const wordSize = Math.round(u * 0.0185);
  ctx.font = font(700, wordSize);
  ctx.letterSpacing = `${(wordSize * 0.13).toFixed(2)}px`;
  ctx.fillStyle = '#e8ecf5';
  ctx.fillText('REAL COST OF AGENT', pad + markSize + u * 0.016, headerY + markSize * 0.46);
  ctx.letterSpacing = '0px';

  ctx.font = font(400, Math.round(u * 0.0145));
  ctx.fillStyle = '#67718a';
  ctx.fillText(TAGLINE, pad + markSize + u * 0.016, headerY + markSize * 0.92);

  // Where the header's ink actually ends, not where its box does — the middle is
  // centred against these two edges, and a generous guess here shows up as the
  // whole card sitting visibly too high.
  const headerBottom = headerY + markSize * 0.92 + h * 0.02;

  /* ---- footer, drawn now so the middle can be centred in what is left ---- */
  const footSize = Math.round(u * 0.0155);
  const footBaseline = h - pad;
  ctx.font = font(500, footSize, MONO);
  ctx.fillStyle = '#a5adff';
  const repoWidth = ctx.measureText(REPO_SHORT).width;
  ctx.fillText(REPO_SHORT, pad, footBaseline);

  const closer = 'runs locally · no account · no API key';
  ctx.font = font(400, footSize);
  ctx.fillStyle = '#67718a';
  const closerWidth = ctx.measureText(closer).width;
  // On the narrow crops the two footer halves collide; stack them instead.
  const stackedFooter = closerWidth + repoWidth + footSize > colWidth;
  ctx.fillText(
    closer,
    stackedFooter ? pad : w - pad - closerWidth,
    stackedFooter ? footBaseline - footSize * 1.7 : footBaseline,
  );
  const footerTop = footBaseline - footSize * (stackedFooter ? 2.9 : 1.3);

  /* ---- the middle ---- */
  const eyebrowSize = Math.round(u * 0.0155);
  const captionSize = Math.round(u * 0.026);
  const metaSize = Math.round(u * 0.0165);
  const barH = Math.round(u * 0.0115);
  const legendSize = Math.round(u * 0.0145);
  const parts = f.split.filter((p) => p.share > 0.004);

  // The number is the point of the card, so it is fitted rather than clipped:
  // somebody with a five-figure total should get a smaller headline, not a
  // headline that runs off the edge into the margin.
  const numberText = imageNumber(f, angle);
  let numberSize = Math.round(u * 0.118);
  ctx.font = font(700, numberSize);
  while (ctx.measureText(numberText).width > colWidth && numberSize > u * 0.05) {
    numberSize = Math.round(numberSize * 0.93);
    ctx.font = font(700, numberSize);
  }

  ctx.font = font(500, captionSize);
  const captionLines = wrap(ctx, imageCaption(f, angle), colWidth);

  // On the tall crops the split becomes a list: a row per component with its own
  // bar. It is more readable at arm's length than a legend under a stacked bar,
  // and it is the content the extra height was missing.
  const listRows = tall ? parts.slice(0, 4) : [];
  const rowHeight = legendSize * 2.5;
  const splitHeight = parts.length
    ? gap * 1.5 + barH + (listRows.length ? gap * 0.7 + listRows.length * rowHeight : gap * 0.9 + legendSize)
    : 0;

  /**
   * The exact distance the stack below will travel.
   *
   * Mirrors the advances one for one rather than estimating them. An estimate
   * that ran long pushed the block up by half its own error, which is how the
   * first version of this card ended up with a hand's width of empty canvas
   * under the legend and none above the eyebrow.
   */
  const stackHeight =
    eyebrowSize +
    gap * 0.5 +
    numberSize * 0.82 +
    // The number carries descenders — a comma, a slash in "/mo" — and the
    // caption sits directly under it in a much smaller size. A single gap here
    // left about twenty pixels between the two at 1200px wide, which reads as a
    // collision even when it is not one.
    gap * 1.35 +
    captionLines.length * captionSize * 1.32 +
    gap * 0.5 +
    metaSize +
    splitHeight;

  let y = headerBottom + Math.max(0, (footerTop - headerBottom - stackHeight) / 2);

  // Eyebrow
  y += eyebrowSize;
  ctx.font = font(600, eyebrowSize);
  ctx.letterSpacing = `${(eyebrowSize * 0.16).toFixed(2)}px`;
  ctx.fillStyle = '#98a2b8';
  ctx.fillText(imageEyebrow(f, angle), pad, y);
  ctx.letterSpacing = '0px';

  // The number
  y += gap * 0.5 + numberSize * 0.82;
  ctx.font = font(700, numberSize);
  const numberWidth = ctx.measureText(numberText).width;
  const numberFill = ctx.createLinearGradient(pad, 0, pad + Math.max(numberWidth, w * 0.4), 0);
  numberFill.addColorStop(0, '#c9cdff');
  numberFill.addColorStop(0.55, BRAND_FROM);
  numberFill.addColorStop(1, BRAND_TO);
  ctx.fillStyle = numberFill;
  ctx.fillText(numberText, pad, y);

  // Caption
  y += gap * 1.35;
  ctx.font = font(500, captionSize);
  ctx.fillStyle = '#e8ecf5';
  for (const line of captionLines) {
    y += captionSize * 1.12;
    ctx.fillText(line, pad, y);
    y += captionSize * 0.2;
  }

  // Meta
  y += gap * 0.5 + metaSize;
  ctx.font = font(400, metaSize);
  ctx.fillStyle = '#67718a';
  ctx.fillText(
    `${plural(f.sessions, 'session')} · ${plural(f.projects, 'project')} · ${plural(f.months, 'month')}`,
    pad,
    y,
  );

  /* ---- the split, which is the part that says this came from real data ---- */
  if (parts.length) {
    y += gap * 1.5;
    const denominator = parts.reduce((sum, p) => sum + p.share, 0) || 1;
    const colorOf = (part) => COMPONENT_COLORS[part.id] ?? '#4b5568';
    const chip = legendSize * 0.72;

    let x = pad;
    ctx.save();
    roundRect(ctx, pad, y, colWidth, barH, barH / 2);
    ctx.clip();
    for (const part of parts) {
      const segment = (part.share / denominator) * colWidth;
      ctx.fillStyle = colorOf(part);
      ctx.fillRect(x, y, segment + 1, barH);
      x += segment;
    }
    ctx.restore();
    y += barH;

    if (listRows.length) {
      // A row per component, each with its own bar. Reads at arm's length on a
      // phone, where a legend under a stacked bar is four tiny labels in a line.
      y += gap * 0.7;
      ctx.font = font(500, legendSize);
      const widest = Math.max(...listRows.map((p) => ctx.measureText(pct(p.share)).width));
      for (const part of listRows) {
        const color = colorOf(part);
        const baseline = y + legendSize;
        ctx.fillStyle = color;
        roundRect(ctx, pad, baseline - chip, chip, chip, chip * 0.3);
        ctx.fill();
        ctx.fillStyle = '#ccd3e2';
        ctx.fillText(part.label, pad + chip + legendSize * 0.6, baseline);
        // Percentages right-aligned to a common edge, so they read as a column
        // rather than as the tail of four different sentences.
        ctx.fillStyle = '#98a2b8';
        ctx.fillText(pct(part.share), pad + colWidth - widest, baseline);

        const track = y + legendSize * 1.5;
        const trackH = legendSize * 0.32;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
        roundRect(ctx, pad, track, colWidth, trackH, trackH / 2);
        ctx.fill();
        ctx.fillStyle = color;
        roundRect(ctx, pad, track, Math.max(trackH, colWidth * (part.share / denominator)), trackH, trackH / 2);
        ctx.fill();
        y += rowHeight;
      }
    } else {
      y += gap * 0.9 + legendSize;
      ctx.font = font(500, legendSize);
      let lx = pad;
      for (const part of parts.slice(0, 4)) {
        const label = `${part.label} ${pct(part.share)}`;
        const width = chip + legendSize * 0.5 + ctx.measureText(label).width + legendSize * 1.5;
        if (lx + width > pad + colWidth) break;
        ctx.fillStyle = colorOf(part);
        roundRect(ctx, lx, y - chip, chip, chip, chip * 0.3);
        ctx.fill();
        ctx.fillStyle = '#98a2b8';
        ctx.fillText(label, lx + chip + legendSize * 0.5, y);
        lx += width;
      }
    }
  }

  return spec;
}

/** The painted card as a PNG blob, for download or for the clipboard. */
export function cardBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas produced no image'))), 'image/png');
  });
}
