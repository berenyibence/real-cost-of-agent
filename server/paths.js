/**
 * Where this application keeps its own state.
 *
 * One preference file, holding the plan you are on and what it costs. That is
 * the only thing about your billing that is not already derivable from the
 * transcripts on disk.
 *
 * This is *this app's* directory, not the agent's. Where the agent state being
 * read lives is `CLAUDE_HOME`, which belongs to `scan.js`.
 *
 * There is one write location per platform and a list of read-only fallbacks
 * behind it, because this file has moved twice: once when the project was
 * renamed, and once when Windows stopped being served by the POSIX answer.
 * Nothing is ever migrated — see `LEGACY_CONFIG_DIRS`.
 */

import path from 'node:path';
import os from 'node:os';

const NAME = 'real-cost-of-agent';

/** What the directory was called when this project was Agent Spend. */
const FORMER_NAME = 'agent-spend';

/**
 * Where the config lives, and everywhere it is worth looking for an older one.
 *
 * Takes the platform and the environment as arguments rather than reading them,
 * so the Windows answer is checkable from a Linux machine and vice versa — the
 * whole failure this function exists to fix was invisible on the platform its
 * author was sitting at. `path` is chosen the same way: `path.win32.join` on a
 * Linux host builds the string Windows would, which is what makes the test
 * mean anything.
 */
export function resolveConfigDirs({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const absolute = (value) =>
    typeof value === 'string' && value && p.isAbsolute(value) ? value : null;

  /**
   * `XDG_CONFIG_HOME` is honoured when it is set to an absolute path, which is
   * what a Linux user who has moved their config expects — and is honoured on
   * every platform, because somebody who exports it on Windows means it just as
   * much. A relative value is ignored rather than resolved against the working
   * directory: the server's cwd is wherever it happened to be started from, and
   * writing config into a checkout because someone exported a relative path is
   * worse than not honouring the variable at all.
   */
  const xdg = absolute(env.XDG_CONFIG_HOME);

  /**
   * `%APPDATA%` is where a Windows application's per-user settings belong, and
   * a dotfile directory in the profile root is not. `~/.config` is not merely
   * unidiomatic there — it is the directory OneDrive's "Known Folder Move" does
   * not follow, so the plan would silently fail to travel with the profile it
   * belongs to while `AppData\Roaming` does exactly that. The literal fallback
   * is what `%APPDATA%` is defined as, for a shell that has unset it.
   *
   * macOS keeps `~/.config` rather than moving to `~/Library/Application
   * Support`. Both are defensible for a CLI, only one of them is where this
   * app's config already is, and a move buys a macOS user nothing but a chance
   * for their plan to go missing.
   */
  const dotConfig = p.join(home, '.config');
  const native =
    platform === 'win32' ? (absolute(env.APPDATA) ?? p.join(home, 'AppData', 'Roaming')) : dotConfig;

  const base = xdg ?? native;
  const dir = p.join(base, NAME);

  /**
   * Read, never written, newest first.
   *
   * A rename that quietly resets somebody's plan is the worst kind of harmless
   * bug: the default plan is a *plausible* plan rather than a blank, so the page
   * would keep showing a confident comparison against a subscription the user is
   * not on, and nothing on screen would suggest checking. That reasoning did not
   * stop applying when the Windows location moved, so the dotfile spellings an
   * older build wrote there are still read.
   *
   * They are added on Windows only, and only when the location was **not**
   * redirected. `XDG_CONFIG_HOME` being set means the user pointed somewhere
   * deliberately, and reaching behind that to the home directory would mean a
   * run with the variable set could still answer with the config it was pointed
   * away from — which is a surprise anywhere, and in a test is the difference
   * between a temporary directory and somebody's real one. On a POSIX machine
   * the question does not arise: `~/.config` is already the base.
   *
   * Nothing is migrated on read. The old file is left where it is, and the first
   * time the plan is edited the new one appears and this stops being consulted.
   */
  const fallbacks = [p.join(base, FORMER_NAME)];
  if (platform === 'win32' && !xdg) {
    fallbacks.push(p.join(dotConfig, NAME), p.join(dotConfig, FORMER_NAME));
  }

  return {
    dir,
    fallbacks: fallbacks.filter((d, i) => d !== dir && fallbacks.indexOf(d) === i),
  };
}

const resolved = resolveConfigDirs();

/** The one directory this app ever writes to. */
export const CONFIG_DIR = resolved.dir;

/** Everywhere a config written by an older version may still be, read-only. */
export const LEGACY_CONFIG_DIRS = resolved.fallbacks;
