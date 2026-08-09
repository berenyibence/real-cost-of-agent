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
