#!/usr/bin/env node
/**
 * cocommit — count the commits you and an AI agent wrote together.
 *
 * Runs in your own CI with your own token, writes an SVG next to your README.
 * Nothing about your repositories leaves the job: only counts are rendered.
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { GitHubClient, collect, AGENTS } from './fetch.js';
import { renderCard, THEMES } from './render.js';

const HELP = `cocommit — how much of your git history you wrote with an AI agent

Usage: cocommit [options]

Options:
  --user <login>       GitHub user to measure (default: token owner)
  --agent <name>       ${Object.keys(AGENTS).join(' | ')} (default: claude)
  --out <path>         SVG output path (default: cocommit.svg)
  --json <path>        also write the raw counts as JSON
  --theme <name>       ${Object.keys(THEMES).join(' | ')} (default: dark)
  --months <n>         months in the bar chart (default: 12)
  --visibility <what>  all | public (default: all)
  --title <text>       override the card heading
  --no-animate         render a static card
  --help

Environment:
  GITHUB_TOKEN         required; needs the 'repo' scope to count private work
`;

function parseArgs(argv) {
  const opts = {
    agent: 'claude', out: 'cocommit.svg', theme: 'dark',
    months: 12, visibility: 'all', animate: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Option ${a} needs a value.`);
      return v;
    };
    switch (a) {
      case '--user': opts.user = next(); break;
      case '--agent': opts.agent = next(); break;
      case '--out': opts.out = next(); break;
      case '--json': opts.json = next(); break;
      case '--theme': opts.theme = next(); break;
      case '--months': opts.months = Number(next()); break;
      case '--visibility': opts.visibility = next(); break;
      case '--title': opts.title = next(); break;
      case '--no-animate': opts.animate = false; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`Unknown option: ${a}`);
    }
  }
  return opts;
}

function validate(opts) {
  if (!AGENTS[opts.agent]) {
    throw new Error(`Unknown agent '${opts.agent}'. Available: ${Object.keys(AGENTS).join(', ')}`);
  }
  if (!THEMES[opts.theme]) {
    throw new Error(`Unknown theme '${opts.theme}'. Available: ${Object.keys(THEMES).join(', ')}`);
  }
  if (!Number.isInteger(opts.months) || opts.months < 1 || opts.months > 24) {
    throw new Error('--months must be a whole number between 1 and 24.');
  }
  if (!['all', 'public'].includes(opts.visibility)) {
    throw new Error("--visibility must be 'all' or 'public'.");
  }
}

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await writeFile(path, contents);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(HELP);
  validate(opts);

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN is not set.\n' +
      "In GitHub Actions the default token cannot search other repositories — " +
      'create a PAT with the `repo` scope and pass it as GITHUB_TOKEN.',
    );
  }

  const log = (m) => console.error(`  ${m}`);
  const client = new GitHubClient({ token, log });

  let user = opts.user;
  if (!user) {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'cocommit' },
    });
    if (!res.ok) throw new Error(`Could not resolve the token owner (HTTP ${res.status}). Pass --user explicitly.`);
    user = (await res.json()).login;
  }

  console.error(`cocommit: measuring @${user} (${opts.months} months, ${opts.visibility})`);
  const started = Date.now();
  const data = await collect({
    client, user, agent: opts.agent, months: opts.months, visibility: opts.visibility,
  });

  await write(opts.out, renderCard(data, {
    theme: opts.theme, animate: opts.animate, title: opts.title,
  }));
  if (opts.json) await write(opts.json, `${JSON.stringify(data, null, 2)}\n`);

  const pct = (data.share * 100).toFixed(1);
  console.error(
    `cocommit: ${data.coauthored.toLocaleString()} of ${data.total.toLocaleString()} commits (${pct}%) ` +
    `· ${client.queries} queries in ${((Date.now() - started) / 1000).toFixed(0)}s → ${opts.out}`,
  );
}

main().catch((err) => {
  console.error(`cocommit: ${err.message}`);
  process.exit(1);
});
