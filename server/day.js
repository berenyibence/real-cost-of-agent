/**
 * Local calendar days.
 *
 * A "day" here means the user's day, not UTC's. Keying buckets with
 * `toISOString().slice(0, 10)` is the version that silently misfiles work: east
 * of Greenwich, an evening session is already tomorrow in UTC and lands under a
 * date the user never worked; west of Greenwich the same mismatch splits one
 * local day across two keys.
 */

const pad = (n) => String(n).padStart(2, '0');

/** The local calendar date of an instant, as YYYY-MM-DD. */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Eleven years. A malformed range must not spin here. */
const MAX_SPAN_DAYS = 4_000;

/**
 * Every local calendar date from `fromKey` to `toKey`, inclusive.
 *
 * Stepped with `setDate` rather than by adding 86,400,000ms. The arithmetic
 * version drifts across a daylight-saving boundary — one day of the year comes
 * out 23 hours long and the sequence either repeats a date or skips one, which
 * in a chart is an off-by-one that only appears twice a year.
 */
export function eachDay(fromKey, toKey) {
  const [y, m, d] = String(fromKey).split('-').map(Number);
  if (!y || !m || !d) return [];
  const cursor = new Date(y, m - 1, d);
  const out = [];
  for (let i = 0; i < MAX_SPAN_DAYS; i++) {
    const key = dayKey(cursor.getTime());
    out.push(key);
    if (key >= String(toKey)) break;
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}
