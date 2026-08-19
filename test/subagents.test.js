/**
 * A subagent's tokens are the session's tokens.
 *
 * Claude Code gives a subagent its own transcript, one directory below the
 * session that spawned it:
 *
 *   projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl
 *
 * Those lines carry their own `requestId` and their own `usage` block, because
 * they were their own API calls. A scanner that reads only the top level leaves
 * that money out of every figure in the app — and leaves it out *silently*,
 * because the cuts all still sum to a total that the work never reached. That is
 * invariant 1 failing with no symptom, which is the worst way for it to fail.
 *
 * The fixtures below are shaped like the real files: a parent on Opus, a
 * subagent on Haiku, so a scanner that drops the nested transcript is wrong
 * about the model mix as well as the total.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'rcoa-subagents-'));
process.env.CLAUDE_HOME = HOME;

const { scan } = await import('../server/scan.js');
const { withEconomics } = await import('../server/store.js');
const { spendBreakdown } = await import('../server/spend.js');

const PROJECT = path.join(HOME, 'projects', '-Users-dev-app');
const SESSION = '11111111-2222-3333-4444-555555555555';

const line = (obj) => `${JSON.stringify(obj)}\n`;

const assistant = ({ id, model, at, input, output, cacheRead = 0, cacheWrite = 0 }) =>
  line({
    type: 'assistant',
    requestId: id,
    timestamp: at,
    cwd: '/Users/dev/app',
    message: {
      id: `msg_${id}`,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        speed: 'standard',
      },
    },
  });

test.before(async () => {
  await fsp.mkdir(path.join(PROJECT, SESSION, 'subagents'), { recursive: true });

  // The session's own transcript: one Opus request.
  fs.writeFileSync(
    path.join(PROJECT, `${SESSION}.jsonl`),
    line({
      type: 'user',
      timestamp: '2026-08-01T10:00:00.000Z',
      cwd: '/Users/dev/app',
      message: { content: 'Refactor the parser' },
    }) +
      assistant({
        id: 'req_parent',
        model: 'claude-opus-5',
        at: '2026-08-01T10:00:05.000Z',
        input: 1_000,
        output: 500,
      }),
  );

  // A subagent's transcript: its own request, to a different model.
  fs.writeFileSync(
    path.join(PROJECT, SESSION, 'subagents', 'agent-abc123.jsonl'),
    line({
      type: 'user',
      timestamp: '2026-08-01T10:00:06.000Z',
      cwd: '/Users/dev/app',
      sessionId: SESSION,
      isSidechain: true,
      message: { content: 'Search the codebase for parser call sites' },
    }) +
      assistant({
        id: 'req_child',
        model: 'claude-haiku-4-5',
        at: '2026-08-01T10:00:09.000Z',
        input: 2_000,
        output: 300,
      }),
  );
});

test.after(async () => {
  await fsp.rm(HOME, { recursive: true, force: true });
});

test('a subagent’s requests are counted, not dropped on the floor', async () => {
  const { sessions } = await scan();
  assert.equal(sessions.length, 1, 'the subagent is part of its session, not a session of its own');

  const [session] = sessions;
  assert.equal(session.requests, 2, 'one parent request and one subagent request');
  assert.equal(session.usage.inputTokens, 3_000);
  assert.equal(session.usage.outputTokens, 800);
});

test('the row is named by the session, never by the subagent that ran inside it', async () => {
  const [session] = (await scan()).sessions;
  // A subagent's opening line is the task it was handed, not anything the user
  // typed, so it must never become the title of the row.
  assert.equal(session.title, 'Refactor the parser');
  assert.equal(session.id, SESSION);
});

test('a subagent on another model is its own billing slice, at its own rate', async () => {
  const [session] = (await scan()).sessions;
  const models = session.usageByModel.map((s) => s.model).sort();
  assert.deepEqual(models, ['claude-haiku-4-5', 'claude-opus-5']);

  const priced = withEconomics(session);
  // Opus 5 at $5/$25 and Haiku 4.5 at $1/$5, per million.
  const expected =
    (1_000 / 1e6) * 5 + (500 / 1e6) * 25 + (2_000 / 1e6) * 1 + (300 / 1e6) * 5;
  assert.ok(
    Math.abs(priced.economics.cost - expected) < 1e-9,
    `each slice at its own rate: got ${priced.economics.cost}, expected ${expected}`,
  );
});

test('the subagent’s spend reaches every cut, so the breakdowns still sum to the total', async () => {
  const { sessions, workspaces } = await scan();
  const breakdown = spendBreakdown(sessions.map(withEconomics), workspaces);

  for (const cut of ['components', 'byModel', 'byProject', 'byDay', 'bySession']) {
    const sum = breakdown[cut].reduce((n, row) => n + row.cost, 0);
    assert.ok(
      Math.abs(sum - breakdown.total) < 1e-9,
      `${cut} sums to ${sum}, total is ${breakdown.total}`,
    );
  }

  // The point of the fixture: the total is not merely self-consistent, it is
  // larger than the parent transcript alone could account for.
  const parentOnly = (1_000 / 1e6) * 5 + (500 / 1e6) * 25;
  assert.ok(breakdown.total > parentOnly, 'the subagent is inside the headline figure');
});

test('a rescan does not fold the same subagent in twice', async () => {
  // The parsed summary of each file is cached and handed back by reference, so
  // merging into it in place would grow a session's cost on every rescan — a
  // leak with no symptom until the app has been left running for a while.
  const first = (await scan()).sessions[0];
  const second = (await scan()).sessions[0];
  assert.equal(second.requests, first.requests);
  assert.equal(second.usage.inputTokens, first.usage.inputTokens);
  assert.equal(second.usage.inputTokens, 3_000);
});

test('a subagent whose parent transcript is gone still has its tokens counted', async () => {
  const orphanProject = path.join(HOME, 'projects', '-Users-dev-orphan');
  const orphanId = '99999999-8888-7777-6666-555555555555';
  await fsp.mkdir(path.join(orphanProject, orphanId, 'subagents'), { recursive: true });
  fs.writeFileSync(
    path.join(orphanProject, orphanId, 'subagents', 'agent-lonely.jsonl'),
    assistant({
      id: 'req_orphan',
      model: 'claude-haiku-4-5',
      at: '2026-08-02T09:00:00.000Z',
      input: 400,
      output: 100,
    }),
  );

  const { sessions } = await scan();
  const orphan = sessions.find((s) => s.id === orphanId);
  assert.ok(orphan, 'a deleted parent does not un-bill the subagent that ran under it');
  assert.equal(orphan.requests, 1);
  assert.equal(orphan.usage.inputTokens, 400);

  await fsp.rm(orphanProject, { recursive: true, force: true });
});
