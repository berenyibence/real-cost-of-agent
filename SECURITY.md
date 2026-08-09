# Security policy

## What this software can reach

Worth stating plainly, because it shapes what a vulnerability here even looks like.

- It **reads** `~/.claude/projects/**/*.jsonl` and `~/.claude/telemetry/*.json`. Those files contain
  your prompts and fragments of your source code.
- It **writes** exactly one file: `~/.config/real-cost-of-agent/config.json`, holding a plan id, a
  price and a seat count.
- It **listens** on `127.0.0.1:4319` by default.
- It **makes no outbound request of any kind.** The share panel's platform links point off-machine,
  but they are `href`s in the page, inert until a person clicks one.

So the interesting failures are: reading something it should not, writing somewhere it should not,
serving a file outside `web/`, or putting something identifying into a share link.

## Supported versions

The `main` branch. This is a single-file-server tool with no release train — fixes land on `main` and
you update by pulling.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/berenyibence/real-cost-of-agent/security/advisories/new)**

That channel is visible only to you and the maintainers.

Useful to include, in rough order of value:

1. What an attacker gets, and what they need in order to get it.
2. Steps to reproduce, ideally against a fixture directory rather than your real `~/.claude` — see
   `CLAUDE_HOME` in the README.
3. The version — the output of `git rev-parse HEAD` is ideal.

**Do not include real transcript content.** If a proof of concept needs a transcript, construct a
fake one; `test/scan.test.js` builds one from scratch and is a good template.

## What to expect

- An acknowledgement within a few days. This is a spare-time project maintained by one person, so
  "days", not "hours".
- An assessment, and agreement on whether it is a real issue and how severe.
- A fix on `main`, and a security advisory crediting you unless you would rather stay anonymous.

Please give a reasonable window before disclosing publicly. There is no bug bounty.

## Things that are known and intended

Reports about these will be closed politely, so it is worth checking first:

- **The server has no authentication.** It binds to loopback and serves data derived from files the
  invoking user can already read. Anyone who can reach `127.0.0.1:4319` on your machine can already
  read `~/.claude` directly.
- **Setting `HOST=0.0.0.0` exposes your usage to the network.** That is what it is for, it is
  documented as "change at your own risk", and it is not a default.
- **There is no CSRF token on `POST /api/billing`.** It writes three numbers to a preference file
  that only affects a comparison shown on the page. Say so if you can escalate it beyond that — that
  would be a real finding.
- **The share panel opens third-party sites.** By design, on an explicit click, with
  `rel="noopener noreferrer"`, and carrying only the aggregates listed in `shareFacts`.

## Things that are definitely reports

- Anything that makes the server read or write outside the paths listed above — path traversal in
  static serving, symlink handling in the scanner, config written outside `XDG_CONFIG_HOME`.
- Anything that puts a project name, a filesystem path, a session title, or transcript content into a
  share URL, the share image, or any request leaving the machine.
- Any outbound network request made by the server or by the page without a click.
- Anything that lets a crafted transcript execute code, exhaust memory, or hang the process
  indefinitely. The scanner parses files this tool did not write.
