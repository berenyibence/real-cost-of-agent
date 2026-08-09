/**
 * Where this application keeps its own state.
 *
 * One preference file, holding the plan you are on and what it costs. That is
 * the only thing about your billing that is not already derivable from the
 * transcripts on disk.
 *
 * This is *this app's* directory, not the agent's. Where the agent state being
 * read lives is `CLAUDE_HOME`, which belongs to `scan.js`.
 */

import path from 'node:path';
import os from 'node:os';

/**
 * `XDG_CONFIG_HOME` is honoured when it is set to an absolute path, which is
 * what a Linux user who has moved their config expects. A relative value is
 * ignored rather than resolved against the working directory — the server's cwd
 * is wherever it happened to be started from, and writing config into a
 * checkout because someone exported a relative path is worse than not honouring
 * the variable at all.
 */
const xdg = process.env.XDG_CONFIG_HOME;
const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config');

export const CONFIG_DIR = path.join(base, 'agent-spend');
