import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect, monthRange, monthEnd, GitHubClient, AGENTS } from '../src/fetch.js';
import { renderCard, THEMES } from '../src/render.js';

/**
 * A client that answers from a map of substring → count, and records queries.
 *
 * Entries are tested longest-first so that a specific pattern such as
 * `co-authored-by:noreply@anthropic.com` wins over the broad `author:kai` that every real
 * query also contains.
 */
function stubClient(answers, { onQuery } = {}) {
  const rules = Object.entries(answers).sort((a, b) => b[0].length - a[0].length);
  const asked = [];
  return {
    asked,
    queries: 0,
    log: () => {},
    async search(q) {
      asked.push(q);
      this.queries++;
      onQuery?.(q);
      for (const [needle, count] of rules) {
        if (q.includes(needle)) return count;
      }
      return 0;
    },
  };
}

test('monthEnd handles month lengths and leap years', () => {
  assert.equal(monthEnd('2026-01'), '2026-01-31');
  assert.equal(monthEnd('2026-04'), '2026-04-30');
  assert.equal(monthEnd('2026-02'), '2026-02-28');
  assert.equal(monthEnd('2024-02'), '2024-02-29', 'leap year');
});

test('monthRange walks backwards across a year boundary', () => {
  assert.deepEqual(monthRange('2026-02', 4), ['2025-11', '2025-12', '2026-01', '2026-02']);
});

test('collect reports totals and share', async () => {
  const client = stubClient({ 'co-authored-by:noreply@anthropic.com': 40, 'author:kai': 100 });
  const data = await collect({ client, user: 'kai', months: 1, now: new Date('2026-09-15T00:00:00Z') });

  assert.equal(data.total, 100);
  assert.equal(data.coauthored, 40);
  assert.equal(data.share, 0.4);
  assert.equal(data.agentLabel, 'Claude');
});

test('collect skips the agent query for months with no commits at all', async () => {
  // A month total of zero bounds the co-authored count at zero, so spending a
  // second rate-limited query on it would be waste.
  const client = stubClient({ 'author-date': 0, 'co-authored-by:noreply@anthropic.com': 5, 'author:kai': 10 });
  await collect({ client, user: 'kai', months: 3, now: new Date('2026-09-15T00:00:00Z') });

  const dated = client.asked.filter((q) => q.includes('author-date'));
  assert.equal(dated.length, 3, 'one query per month, not two');
});

test('collect falls back to full-text when the qualifier matches nothing', async () => {
  // Simulates GitHub dropping the undocumented `co-authored-by:` qualifier
  // such that it matches nothing, while the literal trailer text still does.
  const client = stubClient({
    '"Co-Authored-By: Claude"': 30,
    'co-authored-by:noreply@anthropic.com': 0,
    'author:kai': 100,
  });
  const data = await collect({ client, user: 'kai', months: 1, now: new Date('2026-09-15T00:00:00Z') });

  assert.equal(data.coauthored, 30);
  assert.ok(
    client.asked.some((q) => q.includes('"Co-Authored-By: Claude"')),
    'should have tried the full-text form',
  );
});

test('collect falls back when an unparsed qualifier is ignored entirely', async () => {
  // The likelier failure: GitHub treats the unknown qualifier as free text and
  // returns every commit, so the count silently equals the unfiltered total.
  // A subset can never equal the whole, which is what gives it away.
  const client = stubClient({
    '"Co-Authored-By: Claude"': 30,
    'author:kai': 100,
  });
  const data = await collect({ client, user: 'kai', months: 1, now: new Date('2026-09-15T00:00:00Z') });

  assert.equal(data.coauthored, 30, 'must not report 100% co-authored');
});

test('collect refuses an impossible count it cannot repair', async () => {
  const client = stubClient({ 'co-authored-by:noreply@anthropic.com': 500, 'author:kai': 100 });
  await assert.rejects(
    () => collect({ client, user: 'kai', months: 1, now: new Date('2026-09-15T00:00:00Z') }),
    /only 100 commits in total/,
  );
});

test('collect clamps a month that reports more co-authored than total', async () => {
  const client = stubClient({
    'co-authored-by:noreply@anthropic.com author-date': 99,
    'author-date': 10,
    'co-authored-by:noreply@anthropic.com': 40,
    'author:kai': 100,
  });
  const data = await collect({ client, user: 'kai', months: 1, now: new Date('2026-09-15T00:00:00Z') });

  assert.equal(data.series[0].coauthored, 10, 'a bar cannot exceed its track');
});

test('collect does not invent a fallback for a genuinely zero history', async () => {
  const client = stubClient({ 'author:newcomer': 0 });
  const data = await collect({ client, user: 'newcomer', months: 1, now: new Date('2026-09-15T00:00:00Z') });

  assert.equal(data.coauthored, 0);
  assert.equal(data.share, 0, 'no division by zero');
});

test('collect scopes to public repositories on request', async () => {
  const client = stubClient({ 'author:kai': 10 });
  await collect({ client, user: 'kai', months: 1, visibility: 'public', now: new Date('2026-09-15T00:00:00Z') });

  assert.ok(client.asked.every((q) => q.includes('is:public')));
});

const sample = {
  user: 'kai', agent: 'claude', agentLabel: 'Claude', visibility: 'all',
  generatedAt: '2026-09-20T00:00:00Z', total: 26193, coauthored: 10218, share: 0.39,
  series: [
    { month: '2026-08', total: 2472, coauthored: 1725 },
    { month: '2026-09', total: 2504, coauthored: 2014 },
  ],
};

test('renderCard emits a well-formed, self-contained SVG', () => {
  const svg = renderCard(sample);

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  // camo blocks scripts and every external subresource; a card that needs
  // either silently degrades on the one surface it exists for.
  assert.doesNotMatch(svg, /<script/i);
  assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/, 'no external references');
  assert.doesNotMatch(svg, /@import|url\(/, 'no external fonts');
});

test('renderCard states the real numbers', () => {
  const svg = renderCard(sample);
  assert.match(svg, /26,193/);
  assert.match(svg, /10\.2k/);
  assert.match(svg, /39%/);
});

test('renderCard escapes user-controlled text', () => {
  const svg = renderCard({ ...sample, user: '<script>x</script>&' });
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /&amp;/);
});

test('every theme renders and carries its own colours', () => {
  for (const name of Object.keys(THEMES)) {
    const svg = renderCard(sample, { theme: name });
    assert.match(svg, /<\/svg>$/, `${name} renders`);
    assert.ok(svg.includes(THEMES[name].accent), `${name} uses its accent`);
  }
});

test('static rendering keeps the finished geometry', () => {
  // Renderers that ignore SMIL and CSS must still show full bars, so no
  // element may depend on an animation having run.
  const svg = renderCard(sample, { animate: false });
  assert.doesNotMatch(svg, /<animate/);
  assert.doesNotMatch(svg, /@keyframes/);
  assert.doesNotMatch(svg, /height="0"/, 'bars have real heights');
});

test('animated rendering still declares the finished geometry', () => {
  const svg = renderCard(sample, { animate: true });
  assert.match(svg, /<animate/);
  assert.doesNotMatch(svg, /height="0"/, 'animation supplies "from", not the resting state');
});

test('an empty history renders rather than throwing', () => {
  const svg = renderCard({ ...sample, total: 0, coauthored: 0, share: 0, series: [] });
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /0%/);
});

test('large counts are abbreviated so the hero number fits', () => {
  const svg = renderCard({ ...sample, coauthored: 1234567 });
  assert.match(svg, /1\.2M/);
});

test('GitHubClient refuses to run unauthenticated', () => {
  assert.throws(() => new GitHubClient({ token: '' }), /token is required/i);
});

test('GitHubClient retries once a secondary rate limit clears', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false, status: 403,
        headers: new Map([['retry-after', '0']]),
        text: async () => 'secondary rate limit',
      };
    }
    return { ok: true, status: 200, json: async () => ({ total_count: 7 }) };
  };

  const client = new GitHubClient({ token: 't', fetchImpl });
  assert.equal(await client.search('author:kai'), 7);
  assert.equal(calls, 2);
});

test('GitHubClient surfaces non-rate-limit failures', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 422, headers: new Map(), text: async () => 'Validation failed',
  });
  const client = new GitHubClient({ token: 't', fetchImpl });
  await assert.rejects(() => client.search('bad'), /422/);
});

test('each agent defines both a qualifier and a full-text fallback', () => {
  for (const [name, a] of Object.entries(AGENTS)) {
    assert.ok(a.label, `${name} has a label`);
    assert.ok(a.fallback.startsWith('"'), `${name} has a quoted fallback`);
    // Single or OR'd, every clause must be a co-authored-by qualifier.
    const clauses = a.query.replace(/^\(|\)$/g, '').split(' OR ');
    for (const c of clauses) {
      assert.ok(c.startsWith('co-authored-by:'), `${name}: "${c}" is a qualifier`);
    }
  }
});

test('agents are matched by email address, never by display name', () => {
  // A display name matches any co-author who shares it. Measured against
  // real data, `co-authored-by:claude` also returned a commit whose only
  // extra co-author was an unrelated human, so every agent keys on the
  // address in its trailer instead.
  for (const [name, a] of Object.entries(AGENTS)) {
    const clauses = a.query.replace(/^\(|\)$/g, '').split(' OR ');
    for (const c of clauses) {
      assert.match(c, /co-authored-by:\S+@\S+/, `${name}: "${c}" targets an address`);
    }
  }
});

test('the agent roster covers the tools people actually use', () => {
  // Each of these was verified to return real commits before being added.
  for (const name of ['claude', 'copilot', 'cursor', 'codex', 'devin', 'aider', 'amp', 'jules', 'gemini']) {
    assert.ok(AGENTS[name], `${name} is available`);
  }
});
