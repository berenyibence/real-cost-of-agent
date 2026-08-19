/**
 * The theme, set before the first paint.
 *
 * This runs as a blocking script in `<head>` so the `data-theme` attribute is
 * on the document before anything is drawn — a light-theme user must never see
 * a dark frame flash past first.
 *
 * It is a file rather than an inline `<script>` so that the page's
 * Content-Security-Policy can be a flat `script-src 'self'` with no hash in it.
 * A hash is the version that keeps working until somebody edits this and does
 * not re-run whatever regenerates it, and this project has no build step to
 * regenerate anything.
 */
const stored = localStorage.getItem('real-cost-of-agent-theme');
const preferred = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
document.documentElement.dataset.theme = stored ?? preferred;
